import { GENESIS_HASH, hashEntry, verifyChain, type AuditEntry, type AuditEvent, type VerifyResult } from '../domain/index.js';
import type { Tx } from '../db/pool.js';

interface AuditRow {
  tenant_id: string;
  seq: string;
  invoice_id: string;
  type: string;
  actor: { kind: string; id: string };
  occurred_at: Date;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    tenantId: r.tenant_id,
    invoiceId: r.invoice_id,
    type: r.type,
    actor: r.actor,
    occurredAt: r.occurred_at.toISOString(),
    payload: r.payload,
    seq: Number(r.seq),
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/**
 * Append to the tenant's hash chain (ADR-0009). A per-tenant advisory lock
 * serialises appends, so seq has no gaps and prevHash is always the true tail.
 */
export async function appendAudit(tx: Tx, event: Omit<AuditEvent, 'occurredAt'> & { occurredAt?: string }): Promise<AuditEntry> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [`audit:${event.tenantId}`]);
  const { rows } = await tx.query<{ seq: string; hash: string }>(
    'SELECT seq, hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
    [event.tenantId],
  );
  const last = rows[0];
  const seq = last === undefined ? 0 : Number(last.seq) + 1;
  const prevHash = last === undefined ? GENESIS_HASH : last.hash;
  const full: AuditEvent = { ...event, occurredAt: event.occurredAt ?? new Date().toISOString() };
  // Round-trip the payload through JSON so the hash covers exactly what jsonb will store.
  const payload = JSON.parse(JSON.stringify(full.payload)) as Record<string, unknown>;
  const hashed: AuditEvent = { ...full, payload };
  const hash = hashEntry(seq, prevHash, hashed);
  await tx.query(
    `INSERT INTO audit_log (tenant_id, seq, invoice_id, type, actor, occurred_at, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [hashed.tenantId, seq, hashed.invoiceId, hashed.type, JSON.stringify(hashed.actor), hashed.occurredAt, JSON.stringify(payload), prevHash, hash],
  );
  return { ...hashed, seq, prevHash, hash };
}

export async function invoiceHistory(tx: Tx, tenantId: string, invoiceId: string): Promise<AuditEntry[]> {
  const { rows } = await tx.query<AuditRow>(
    'SELECT * FROM audit_log WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY seq',
    [tenantId, invoiceId],
  );
  return rows.map(toEntry);
}

export async function verifyTenantChain(tx: Tx, tenantId: string): Promise<{ entries: number; result: VerifyResult }> {
  const { rows } = await tx.query<AuditRow>('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq', [tenantId]);
  return { entries: rows.length, result: verifyChain(rows.map(toEntry)) };
}

/** The tenant's whole chain, in order. */
export async function tenantChain(tx: Tx, tenantId: string): Promise<AuditEntry[]> {
  const { rows } = await tx.query<AuditRow>('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq', [tenantId]);
  return rows.map(toEntry);
}
