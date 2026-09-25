import { createHash } from 'node:crypto';

/**
 * Hash-chained, append-only audit ledger (ADR-0009). Each entry commits to the
 * previous entry's hash, so editing or deleting any row breaks every later hash.
 * The database enforces append-only with grants and triggers; this module is the
 * canonical hashing and verification logic both writers and auditors use.
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEvent {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly type: string;
  readonly actor: { readonly kind: string; readonly id: string };
  readonly occurredAt: string; // RFC 3339 UTC
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuditEntry extends AuditEvent {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
}

/** Deterministic JSON: sorted keys, no whitespace; bigint encoded as a decimal string. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not canonicalizable');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`);
}

export function hashEntry(seq: number, prevHash: string, event: AuditEvent): string {
  const body = canonicalJson({ seq, prevHash, event });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function appendEntry(chain: readonly AuditEntry[], event: AuditEvent): AuditEntry {
  const last = chain.at(-1);
  const seq = last === undefined ? 0 : last.seq + 1;
  const prevHash = last === undefined ? GENESIS_HASH : last.hash;
  return { ...event, seq, prevHash, hash: hashEntry(seq, prevHash, event) };
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly brokenAt: number; readonly reason: string };

function eventOf(entry: AuditEntry): AuditEvent {
  const { tenantId, invoiceId, type, actor, occurredAt, payload } = entry;
  return { tenantId, invoiceId, type, actor, occurredAt, payload };
}

export function verifyChain(chain: readonly AuditEntry[]): VerifyResult {
  let prev = GENESIS_HASH;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (entry === undefined) return { ok: false, brokenAt: i, reason: 'missing entry' };
    if (entry.seq !== i) return { ok: false, brokenAt: i, reason: `expected seq ${i}, got ${entry.seq}` };
    if (entry.prevHash !== prev) return { ok: false, brokenAt: i, reason: 'prevHash does not match previous entry' };
    if (hashEntry(entry.seq, entry.prevHash, eventOf(entry)) !== entry.hash) {
      return { ok: false, brokenAt: i, reason: 'hash does not match entry contents' };
    }
    prev = entry.hash;
  }
  return { ok: true };
}
