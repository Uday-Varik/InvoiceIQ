import { createHash, randomUUID } from 'node:crypto';
import { approvalTierFor, isReasonCode, type InvoiceState, type Policy, type ReasonCode } from '../domain/index.js';
import { withTenant, type Db, type Tx } from '../db/pool.js';
import { roleCovers, type Principal } from '../auth/auth.js';
import { HttpProblem } from '../http/problem.js';
import { idempotent, requestHash, type StoredResponse } from '../http/idempotency.js';
import { enqueue } from '../outbox/enqueue.js';
import { appendAudit, invoiceHistory } from './audit.js';
import { transition, TransitionRefusedError } from './lifecycle.js';
import { planCorrection, type CorrectionInput } from './corrections.js';
import { continueFromValidating, loadPolicy } from './pipeline.js';
import { approvalsOf, approvalView, recordApproval } from './approvals.js';
import {
  applyCorrection,
  findByDocument,
  getInvoice,
  getLineItems,
  insertDocument,
  insertInvoice,
  replaceLineItems,
  type DocumentContentType,
  type InvoiceRow,
  type SourceChannel,
} from './store.js';
import { toInvoice } from './view.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Decide the type from the bytes; the client's Content-Type is not trusted. */
export function sniffContentType(bytes: Buffer): DocumentContentType | undefined {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  return undefined;
}

export function safeFilename(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const base = (raw ?? '').split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f"]/g, '').trim() ?? '';
  return (base || 'upload').slice(0, 255);
}

const HUMAN_TRANSITION_STATUS: Partial<Record<TransitionRefusedError['code'], number>> = {
  REASON_REQUIRED: 422,
  REASON_OUTCOME_MISMATCH: 422,
  AI_REASON_OUTSIDE_HOLD: 422,
};

function refused(err: TransitionRefusedError): HttpProblem {
  return new HttpProblem(HUMAN_TRANSITION_STATUS[err.code] ?? 409, 'Transition refused', err.message, err.code);
}

async function mustGet(tx: Tx, id: string): Promise<InvoiceRow> {
  const inv = await getInvoice(tx, id, { forUpdate: true });
  if (!inv) throw new HttpProblem(404, 'Not found', `no invoice ${id}`);
  return inv;
}

/**
 * Approval authority. Tiers are denominated in the tenant base currency; with
 * no FX in Phase 1, an invoice in another currency needs the top tier's role.
 */
export function checkApprovalAuthority(principal: Principal, invoice: InvoiceRow, policy: Policy): void {
  if (invoice.total_minor === null || invoice.currency === null) {
    throw new HttpProblem(409, 'Cannot approve', 'the invoice has no extracted total and currency', 'TOTAL_UNKNOWN');
  }
  const top = policy.approvalTiers.at(-1);
  const tier = invoice.currency === policy.baseCurrency ? approvalTierFor(policy, BigInt(invoice.total_minor)) : top;
  if (!tier) throw new HttpProblem(403, 'Approval limit exceeded', 'the total is above every approval tier', 'APPROVAL_LIMIT_EXCEEDED');
  if (!roleCovers(principal.roles, tier.approverRole)) {
    throw new HttpProblem(403, 'Insufficient approval authority', `the ${tier.name} tier needs role ${tier.approverRole}`, 'ROLE_INSUFFICIENT');
  }
}

export interface UploadInput {
  readonly content: Buffer;
  readonly filename: string | undefined;
  readonly sourceChannel: SourceChannel;
  readonly idempotencyKey: string;
}

export async function uploadInvoice(db: Db, principal: Principal, input: UploadInput): Promise<StoredResponse & { replayed: boolean }> {
  if (input.content.length === 0) throw new HttpProblem(400, 'Empty file', 'the uploaded file is empty');
  const contentType = sniffContentType(input.content);
  if (!contentType) throw new HttpProblem(415, 'Unsupported document type', 'upload a PDF, PNG or JPEG file');
  const sha256 = createHash('sha256').update(input.content).digest('hex');
  const filename = safeFilename(input.filename);
  const hash = requestHash(['createInvoice', sha256, input.sourceChannel]);

  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, input.idempotencyKey, hash, async () => {
      const existing = await findByDocument(tx, sha256);
      if (existing) {
        throw new HttpProblem(409, 'Duplicate document', `this document was already uploaded as invoice ${existing.id}`, 'DUPLICATE_DOCUMENT');
      }
      const id = randomUUID();
      await insertDocument(tx, { tenantId: principal.tenantId, sha256, contentType, content: input.content });
      await insertInvoice(tx, { id, tenantId: principal.tenantId, sourceChannel: input.sourceChannel, documentSha256: sha256, filename, createdBy: principal.userId });
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: id,
        type: 'invoice.received',
        actor: { kind: 'human', id: principal.userId },
        payload: { to: 'RECEIVED', documentSha256: sha256, contentType, sizeBytes: input.content.length, sourceChannel: input.sourceChannel },
      });
      await enqueue(tx, principal.tenantId, 'invoice.received', { invoiceId: id });
      const row = await getInvoice(tx, id);
      if (!row) throw new Error('inserted invoice not visible');
      return { status: 201, body: toInvoice(row) };
    }),
  );
}

export interface HumanTransitionInput {
  readonly invoiceId: string;
  readonly to: InvoiceState;
  readonly reasons?: readonly string[];
  readonly comment?: string;
  readonly idempotencyKey: string;
  readonly operation: 'transitionInvoice' | 'approveInvoice' | 'rejectInvoice';
}

export async function humanTransition(db: Db, principal: Principal, input: HumanTransitionInput): Promise<StoredResponse & { replayed: boolean }> {
  const reasons = input.reasons ?? [];
  const unknown = reasons.find((r) => !isReasonCode(r));
  if (unknown !== undefined) throw new HttpProblem(422, 'Unknown reason code', `${unknown} is not in the reason catalog`);
  const hash = requestHash([input.operation, input.invoiceId, input.to, JSON.stringify(reasons), input.comment ?? '']);

  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, input.idempotencyKey, hash, async () => {
      const inv = await mustGet(tx, input.invoiceId);
      if (input.to === 'APPROVED') {
        try {
          const policy = await loadPolicy(tx);
          const updated = await recordApproval(tx, principal, inv, policy, input.comment);
          return { status: 200, body: toInvoice(updated, { approval: approvalView(updated, await approvalsOf(tx, updated.id), policy) }) };
        } catch (err) {
          if (err instanceof TransitionRefusedError) throw refused(err);
          throw err;
        }
      }
      if (input.to === 'PAYMENT_QUEUED' || input.to === 'PAID') {
        throw new HttpProblem(409, 'Transition refused', 'payments move only through payment runs (/v1/payment-runs)', 'EDGE_NOT_ALLOWED');
      }
      try {
        let updated = await transition(tx, inv, {
          to: input.to,
          actor: { kind: 'human', id: principal.userId },
          reasons: reasons as ReasonCode[],
          ...(input.comment ? { comment: input.comment } : {}),
        });
        // A human sending an invoice back to VALIDATING wants it validated now, not parked there.
        updated = await continueFromValidating(tx, updated);
        return { status: 200, body: toInvoice(updated) };
      } catch (err) {
        if (err instanceof TransitionRefusedError) throw refused(err);
        throw err;
      }
    }),
  );
}

export async function readInvoice(db: Db, principal: Principal, id: string) {
  return withTenant(db, principal.tenantId, async (tx) => {
    const inv = await getInvoice(tx, id);
    if (!inv) throw new HttpProblem(404, 'Not found', `no invoice ${id}`);
    return toInvoice(inv, {
      history: await invoiceHistory(tx, principal.tenantId, id),
      lineItems: await getLineItems(tx, id),
      approval: approvalView(inv, await approvalsOf(tx, id), await loadPolicy(tx)),
    });
  });
}

const CORRECTED_BEFORE_APPROVAL = 'corrected before approval; re-validating';

/**
 * Edit-before-approve. In one transaction: apply the correction (compare-and-set
 * on version), audit the before and after of every changed field, then send the
 * invoice back through deterministic validation and policy routing. From
 * PENDING_APPROVAL that goes via HOLD, because the gate only lets a human leave
 * HOLD or EXCEPTION for VALIDATING. The response is the invoice where routing
 * left it: usually PENDING_APPROVAL again, or EXCEPTION if the corrected numbers
 * do not add up.
 */
export async function correctInvoice(
  db: Db,
  principal: Principal,
  invoiceId: string,
  input: CorrectionInput,
  idempotencyKey: string,
): Promise<StoredResponse & { replayed: boolean }> {
  const hash = requestHash(['correctInvoice', invoiceId, JSON.stringify(input)]);
  const actor = { kind: 'human', id: principal.userId } as const;

  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, idempotencyKey, hash, async () => {
      const inv = await mustGet(tx, invoiceId);
      const plan = planCorrection(inv, await getLineItems(tx, invoiceId), input);
      const fields = Object.keys(plan.changes);
      if (!(await applyCorrection(tx, invoiceId, inv.version, plan.update, fields))) {
        throw new HttpProblem(409, 'Version conflict', 'the invoice changed while this request was in flight; reload and retry', 'VERSION_CONFLICT');
      }
      if (plan.lines) await replaceLineItems(tx, principal.tenantId, invoiceId, plan.lines);
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId,
        type: 'invoice.corrected',
        actor,
        payload: { changes: plan.changes, ...(input.comment ? { comment: input.comment } : {}) },
      });
      await enqueue(tx, principal.tenantId, 'invoice.corrected', { invoiceId, fields });

      let cur = await mustGet(tx, invoiceId);
      try {
        if (cur.state === 'PENDING_APPROVAL') {
          cur = await transition(tx, cur, { to: 'HOLD', actor, reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'], comment: CORRECTED_BEFORE_APPROVAL });
        }
        cur = await transition(tx, cur, { to: 'VALIDATING', actor, ...(input.comment ? { comment: input.comment } : {}) });
      } catch (err) {
        if (err instanceof TransitionRefusedError) throw refused(err);
        throw err;
      }
      cur = await continueFromValidating(tx, cur);
      return { status: 200, body: toInvoice(cur, { lineItems: await getLineItems(tx, invoiceId) }) };
    }),
  );
}
