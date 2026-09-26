import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/pool.js';
import { currentTrace, formatTraceparent } from '../observability/trace.js';

export type OutboxTopic =
  | 'invoice.received'
  | 'invoice.state_changed'
  | 'invoice.corrected'
  | 'vendor.bank_change_requested'
  | 'payment_run.created'
  | 'payment_run.closed';

/** Write an event in the caller's transaction: it exists if and only if the change commits (ADR-0003). */
export async function enqueue(tx: Tx, tenantId: string, topic: OutboxTopic, payload: Record<string, unknown>): Promise<string> {
  const eventId = randomUUID();
  const trace = currentTrace();
  await tx.query('INSERT INTO outbox (tenant_id, event_id, topic, payload, traceparent) VALUES ($1, $2, $3, $4, $5)', [
    tenantId,
    eventId,
    topic,
    JSON.stringify(payload),
    trace ? formatTraceparent(trace) : null,
  ]);
  return eventId;
}
