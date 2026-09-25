import { evaluateTransition, type Actor, type InvoiceState, type ReasonCode, type TransitionError } from '../domain/index.js';
import type { Tx } from '../db/pool.js';
import { enqueue } from '../outbox/enqueue.js';
import { appendAudit } from './audit.js';
import { getInvoice, updateState, type InvoiceRow } from './store.js';

export class TransitionRefusedError extends Error {
  override name = 'TransitionRefusedError';
  constructor(
    readonly code: TransitionError | 'CONCURRENT_UPDATE',
    message: string,
  ) {
    super(message);
  }
}

const OUTCOME_STATES: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['HOLD', 'EXCEPTION', 'REJECTED']);

export interface TransitionInput {
  readonly to: InvoiceState;
  readonly actor: Actor;
  readonly reasons?: readonly ReasonCode[];
  readonly comment?: string;
  /** Extra facts for the audit entry (signals, validation findings). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The only way invoice state changes. The pure gate decides; this function
 * records the decision: row update (compare-and-set on version), audit entry and
 * outbox event, all in the caller's transaction, so none can exist without the others.
 */
export async function transition(tx: Tx, invoice: InvoiceRow, input: TransitionInput): Promise<InvoiceRow> {
  const reasons = [...new Set(input.reasons ?? [])];
  const verdict = evaluateTransition({ from: invoice.state, to: input.to, actor: input.actor, reasons });
  if (!verdict.ok) throw new TransitionRefusedError(verdict.error, verdict.message);

  const kept = OUTCOME_STATES.has(input.to) ? reasons : [];
  if (!(await updateState(tx, invoice.id, invoice.version, input.to, kept))) {
    throw new TransitionRefusedError('CONCURRENT_UPDATE', 'the invoice changed while this request was in flight; reload and retry');
  }
  await appendAudit(tx, {
    tenantId: invoice.tenant_id,
    invoiceId: invoice.id,
    type: 'invoice.transitioned',
    actor: input.actor,
    payload: {
      from: invoice.state,
      to: input.to,
      reasons,
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.details ? { details: input.details } : {}),
    },
  });
  await enqueue(tx, invoice.tenant_id, 'invoice.state_changed', {
    invoiceId: invoice.id,
    from: invoice.state,
    to: input.to,
    version: invoice.version + 1,
  });
  const updated = await getInvoice(tx, invoice.id);
  if (!updated) throw new Error(`invoice ${invoice.id} vanished inside its own transaction`);
  return updated;
}
