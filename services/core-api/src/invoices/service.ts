import { createHash, randomUUID } from 'node:crypto';
import { approvalTierFor, isReasonCode, type InvoiceState, type Policy, type ReasonCode } from '../domain/index.js';
import { withTenant, type Db, type Tx } from '../db/pool.js';
import { roleCovers, type Principal } from '../auth/auth.js';
import { HttpProblem } from '../http/problem.js';
import { idempotent, requestHash, type StoredResponse } from '../http/idempotency.js';
import { enqueue } from '../outbox/enqueue.js';
import { appendAudit, invoiceHistory } from './audit.js';
import { transition, TransitionRefusedError } from './lifecycle.js';
import { loadPolicy } from './pipeline.js';
import { findByDocument, getInvoice, insertDocument, insertInvoice, type DocumentContentType, type InvoiceRow, type SourceChannel } from './store.js';
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
        if (inv.state !== 'PENDING_APPROVAL') {
          throw new HttpProblem(409, 'Transition refused', `only PENDING_APPROVAL invoices can be approved; this one is ${inv.state}`, 'EDGE_NOT_ALLOWED');
        }
        checkApprovalAuthority(principal, inv, await loadPolicy(tx));
      }
      try {
        const updated = await transition(tx, inv, {
          to: input.to,
          actor: { kind: 'human', id: principal.userId },
          reasons: reasons as ReasonCode[],
          ...(input.comment ? { comment: input.comment } : {}),
        });
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
    return toInvoice(inv, await invoiceHistory(tx, principal.tenantId, id));
  });
}
