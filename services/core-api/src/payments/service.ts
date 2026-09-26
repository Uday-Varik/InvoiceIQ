import { randomUUID } from 'node:crypto';
import { planPaymentRun, type Actor } from '../domain/index.js';
import { withTenant, type Db, type Tx } from '../db/pool.js';
import { loadPolicy } from '../db/policy.js';
import type { Principal } from '../auth/auth.js';
import { requireDifferentPerson, requireRole } from '../auth/require.js';
import { HttpProblem } from '../http/problem.js';
import { idempotent, requestHash, type StoredResponse } from '../http/idempotency.js';
import { enqueue } from '../outbox/enqueue.js';
import { appendAudit } from '../invoices/audit.js';
import { csvText, formatMinor } from '../invoices/export.js';
import { transition } from '../invoices/lifecycle.js';
import { getInvoice, lockApproved, lockRunInvoices, type InvoiceRow } from '../invoices/store.js';
import { ensureVendor, paymentBlocks } from '../vendors/service.js';
import { latestBankChanges, linkInvoiceVendor } from '../vendors/store.js';
import {
  assignRun,
  clearRun,
  closePaymentRun,
  getPaymentRun,
  insertPaymentRun,
  insertRunItems,
  listPaymentRuns,
  runItems,
  type PaymentRunRow,
  type PaymentRunStatus,
  type RunItemRow,
} from './store.js';

/**
 * Payment runs (ADR-0016). Assembling a run moves APPROVED invoices to
 * PAYMENT_QUEUED and freezes what will be paid to which account; confirming it
 * (a different, more senior person) moves them to PAID; cancelling puts them on
 * HOLD so they need a fresh approval. Invoices for vendors that cannot be paid
 * are held instead of queued. AI actors take no part (ADR-0007).
 */

export const MAX_RUN_INVOICES = 500;

function runView(r: PaymentRunRow, items?: readonly RunItemRow[]) {
  return {
    id: r.id,
    currency: r.currency,
    status: r.status,
    invoiceCount: r.invoice_count,
    total: { amountMinor: r.total_minor, currency: r.currency },
    version: r.version,
    ...(r.comment ? { comment: r.comment } : {}),
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    ...(r.closed_by ? { closedBy: r.closed_by } : {}),
    ...(r.closed_at ? { closedAt: r.closed_at.toISOString() } : {}),
    ...(r.close_comment ? { closeComment: r.close_comment } : {}),
    ...(items
      ? {
          items: items.map((it) => ({
            invoiceId: it.invoice_id,
            vendorId: it.vendor_id,
            vendorName: it.vendor_name,
            accountLast4: it.account_last4,
            amount: { amountMinor: it.amount_minor, currency: r.currency },
            invoiceNumber: it.invoice_number,
            dueDate: it.due_date,
            state: it.state,
          })),
        }
      : {}),
  };
}

async function mustRun(tx: Tx, id: string, forUpdate = false): Promise<PaymentRunRow> {
  const run = await getPaymentRun(tx, id, { forUpdate });
  if (!run) throw new HttpProblem(404, 'Not found', `no payment run ${id}`);
  return run;
}

export async function readPaymentRuns(db: Db, principal: Principal, opts: { status?: PaymentRunStatus; limit: number }) {
  return withTenant(db, principal.tenantId, async (tx) => ({ items: (await listPaymentRuns(tx, opts)).map((r) => runView(r)) }));
}

export async function readPaymentRun(db: Db, principal: Principal, id: string) {
  return withTenant(db, principal.tenantId, async (tx) => {
    const run = await mustRun(tx, id);
    return runView(run, await runItems(tx, id));
  });
}

export interface CreateRunInput {
  readonly currency: string;
  readonly invoiceIds?: readonly string[];
  readonly comment?: string;
}

const HELD_COMMENT = 'held while assembling a payment run';

export async function createPaymentRun(db: Db, principal: Principal, input: CreateRunInput, key: string): Promise<StoredResponse & { replayed: boolean }> {
  requireRole(principal, 'ap_manager', 'assembling a payment run');
  const ids = input.invoiceIds ? [...new Set(input.invoiceIds)] : undefined;
  const hash = requestHash(['createPaymentRun', input.currency, JSON.stringify(ids ?? null), input.comment ?? '']);
  const actor: Actor = { kind: 'human', id: principal.userId };

  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, key, hash, async () => {
      const policy = await loadPolicy(tx);
      let candidates = await lockApproved(tx, input.currency, ids, MAX_RUN_INVOICES);
      if (ids !== undefined && candidates.length !== ids.length) {
        const found = new Set(candidates.map((c) => c.id));
        const missing = ids.filter((id) => !found.has(id));
        throw new HttpProblem(409, 'Not payable', `not APPROVED in ${input.currency}: ${missing.join(', ')}`, 'INVOICE_NOT_PAYABLE');
      }
      // Invoices approved before the vendor master existed get linked now.
      candidates = await Promise.all(
        candidates.map(async (c) => {
          if (c.vendor_id !== null || c.vendor_name === null) return c;
          const v = await ensureVendor(tx, principal.tenantId, c.vendor_name, actor);
          if (!v) return c;
          await linkInvoiceVendor(tx, c.id, v.id);
          return { ...c, vendor_id: v.id };
        }),
      );
      const vendorIds = candidates.flatMap((c) => (c.vendor_id ? [c.vendor_id] : []));
      const blocks = await paymentBlocks(tx, vendorIds, policy, new Date());
      const plan = planPaymentRun(
        input.currency,
        candidates.map((c) => ({ id: c.id, currency: c.currency, totalMinor: c.total_minor === null ? null : BigInt(c.total_minor), vendorId: c.vendor_id })),
        (vendorId) => blocks.get(vendorId),
      );

      const byId = new Map(candidates.map((c) => [c.id, c]));
      const held: Array<{ invoiceId: string; reason: string }> = [];
      const skipped: Array<{ invoiceId: string; why: string }> = [];
      for (const x of plan.excluded) {
        if (x.action === 'skip') {
          skipped.push({ invoiceId: x.id, why: x.why });
          continue;
        }
        const inv = byId.get(x.id);
        if (!inv) continue;
        await transition(tx, inv, { to: 'HOLD', actor, reasons: [x.reason], comment: HELD_COMMENT });
        held.push({ invoiceId: x.id, reason: x.reason });
      }
      if (plan.queue.length === 0) return { status: 200, body: { run: null, held, skipped } };

      const runId = randomUUID();
      const run = await insertPaymentRun(tx, {
        tenantId: principal.tenantId,
        id: runId,
        currency: input.currency,
        invoiceCount: plan.queue.length,
        totalMinor: plan.totalMinor,
        comment: input.comment,
        createdBy: principal.userId,
      });
      const latest = await latestBankChanges(tx, plan.queue.flatMap((q) => (q.vendorId ? [q.vendorId] : [])));
      await insertRunItems(
        tx,
        principal.tenantId,
        runId,
        plan.queue.map((q) => {
          const change = q.vendorId ? latest.get(q.vendorId) : undefined;
          return {
            invoiceId: q.id,
            vendorId: q.vendorId as string,
            accountLast4: change?.account_last4 ?? null,
            bankChangeId: change?.id ?? null,
            amountMinor: q.totalMinor as bigint,
          };
        }),
      );
      await assignRun(
        tx,
        plan.queue.map((q) => q.id),
        runId,
      );
      for (const q of plan.queue) {
        const inv = byId.get(q.id);
        if (!inv) continue;
        await transition(tx, { ...inv, payment_run_id: runId }, { to: 'PAYMENT_QUEUED', actor, details: { paymentRunId: runId } });
      }
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: runId,
        type: 'payment_run.created',
        actor,
        payload: {
          currency: input.currency,
          invoiceIds: plan.queue.map((q) => q.id),
          totalMinor: plan.totalMinor.toString(),
          held,
          ...(input.comment ? { comment: input.comment } : {}),
        },
      });
      await enqueue(tx, principal.tenantId, 'payment_run.created', { paymentRunId: runId });
      return { status: 201, body: { run: runView(run, await runItems(tx, runId)), held, skipped } };
    }),
  );
}

export interface CloseRunInput {
  readonly expectedVersion: number;
  readonly comment?: string;
}

function checkOpen(run: PaymentRunRow, expectedVersion: number): void {
  if (run.status !== 'queued') throw new HttpProblem(409, 'Run closed', `the payment run is already ${run.status}`, 'RUN_CLOSED');
  if (run.version !== expectedVersion) {
    throw new HttpProblem(409, 'Version conflict', `the payment run is at version ${run.version}; reload and retry`, 'VERSION_CONFLICT');
  }
}

/**
 * Record that the bank executed the run. Refused when anything that decided
 * where the money goes has changed since the run was assembled: an invoice
 * left the run, a vendor became blocked, or a vendor's account changed.
 */
export async function confirmPaymentRun(db: Db, principal: Principal, runId: string, input: CloseRunInput, key: string): Promise<StoredResponse & { replayed: boolean }> {
  requireRole(principal, 'controller', 'confirming a payment run');
  const actor: Actor = { kind: 'human', id: principal.userId };
  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, key, requestHash(['confirmPaymentRun', runId, JSON.stringify(input)]), async () => {
      const run = await mustRun(tx, runId, true);
      checkOpen(run, input.expectedVersion);
      requireDifferentPerson(principal, run.created_by, 'the person who assembled a payment run cannot confirm it');

      const items = await runItems(tx, runId);
      const invoices = await lockRunInvoices(tx, runId);
      const queued = new Set(invoices.filter((i) => i.state === 'PAYMENT_QUEUED').map((i) => i.id));
      const left = items.filter((it) => !queued.has(it.invoice_id)).map((it) => it.invoice_id);
      if (left.length > 0) {
        throw new HttpProblem(409, 'Run changed', `invoices no longer queued in this run: ${left.join(', ')}; cancel the run and assemble a new one`, 'RUN_INCOMPLETE');
      }
      const vendorIds = items.map((it) => it.vendor_id);
      const blocks = await paymentBlocks(tx, vendorIds, await loadPolicy(tx), new Date());
      const blocked = [...new Set(vendorIds.filter((v) => blocks.get(v)?.blocked))];
      if (blocked.length > 0) {
        throw new HttpProblem(409, 'Vendor blocked', `payments to these vendors are blocked now: ${blocked.join(', ')}; cancel the run`, 'VENDOR_BLOCKED');
      }
      const latest = await latestBankChanges(tx, vendorIds);
      const changed = [...new Set(items.filter((it) => (latest.get(it.vendor_id)?.id ?? null) !== it.bank_change_id).map((it) => it.vendor_id))];
      if (changed.length > 0) {
        throw new HttpProblem(409, 'Bank details changed', `bank details changed since the run was assembled for: ${changed.join(', ')}; cancel the run`, 'BANK_DETAILS_CHANGED');
      }

      for (const inv of invoices) {
        await transition(tx, inv, { to: 'PAID', actor, details: { paymentRunId: runId }, ...(input.comment ? { comment: input.comment } : {}) });
      }
      if (!(await closePaymentRun(tx, runId, run.version, 'paid', principal.userId, input.comment))) {
        throw new HttpProblem(409, 'Version conflict', 'the payment run changed while this request was in flight', 'VERSION_CONFLICT');
      }
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: runId,
        type: 'payment_run.paid',
        actor,
        payload: { invoiceIds: invoices.map((i) => i.id), totalMinor: run.total_minor, ...(input.comment ? { comment: input.comment } : {}) },
      });
      await enqueue(tx, principal.tenantId, 'payment_run.closed', { paymentRunId: runId, status: 'paid' });
      return { status: 200, body: runView((await getPaymentRun(tx, runId)) as PaymentRunRow, await runItems(tx, runId)) };
    }),
  );
}

const CANCELLED_COMMENT = 'payment run cancelled; needs a fresh approval';

export async function cancelPaymentRun(db: Db, principal: Principal, runId: string, input: CloseRunInput, key: string): Promise<StoredResponse & { replayed: boolean }> {
  requireRole(principal, 'ap_manager', 'cancelling a payment run');
  if (!input.comment?.trim()) throw new HttpProblem(422, 'Comment required', 'say why the run is cancelled', 'COMMENT_REQUIRED');
  const actor: Actor = { kind: 'human', id: principal.userId };
  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, key, requestHash(['cancelPaymentRun', runId, JSON.stringify(input)]), async () => {
      const run = await mustRun(tx, runId, true);
      checkOpen(run, input.expectedVersion);
      const invoices = await lockRunInvoices(tx, runId);
      const held: string[] = [];
      for (const inv of invoices) {
        if (inv.state !== 'PAYMENT_QUEUED') continue;
        await transition(tx, inv, { to: 'HOLD', actor, reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'], comment: CANCELLED_COMMENT, details: { paymentRunId: runId } });
        held.push(inv.id);
      }
      await clearRun(tx, runId);
      if (!(await closePaymentRun(tx, runId, run.version, 'cancelled', principal.userId, input.comment))) {
        throw new HttpProblem(409, 'Version conflict', 'the payment run changed while this request was in flight', 'VERSION_CONFLICT');
      }
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: runId,
        type: 'payment_run.cancelled',
        actor,
        payload: { heldInvoiceIds: held, comment: input.comment },
      });
      await enqueue(tx, principal.tenantId, 'payment_run.closed', { paymentRunId: runId, status: 'cancelled' });
      return { status: 200, body: runView((await getPaymentRun(tx, runId)) as PaymentRunRow, await runItems(tx, runId)) };
    }),
  );
}

export const PAYMENT_FILE_COLUMNS = [
  'payment_run_id',
  'invoice_id',
  'vendor_id',
  'vendor_name',
  'account_last4',
  'invoice_number',
  'invoice_date',
  'due_date',
  'currency',
  'amount',
  'amount_minor',
] as const;

/** The file handed to the bank or ERP: the frozen snapshot, never live invoice data. */
export function paymentFileCsv(run: PaymentRunRow, items: readonly RunItemRow[]): string {
  const lines = [PAYMENT_FILE_COLUMNS.join(',')];
  for (const it of items) {
    lines.push(
      [
        run.id,
        it.invoice_id,
        it.vendor_id,
        csvText(it.vendor_name),
        csvText(it.account_last4),
        csvText(it.invoice_number),
        it.invoice_date ?? '',
        it.due_date ?? '',
        run.currency,
        formatMinor(it.amount_minor, run.currency),
        it.amount_minor,
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function paymentFile(db: Db, principal: Principal, runId: string): Promise<{ filename: string; csv: string }> {
  requireRole(principal, 'ap_manager', 'downloading a payment file');
  return withTenant(db, principal.tenantId, async (tx) => {
    const run = await mustRun(tx, runId);
    if (run.status === 'cancelled') throw new HttpProblem(409, 'Run cancelled', 'a cancelled run has no payment file', 'RUN_CLOSED');
    return { filename: `payment-run-${run.id.slice(0, 8)}-${run.currency}.csv`, csv: paymentFileCsv(run, await runItems(tx, runId)) };
  });
}

/** For tests and the invoice view: the run an invoice is in, if any. */
export async function runOf(tx: Tx, invoiceId: string): Promise<PaymentRunRow | undefined> {
  const inv: InvoiceRow | undefined = await getInvoice(tx, invoiceId);
  return inv?.payment_run_id ? getPaymentRun(tx, inv.payment_run_id) : undefined;
}
