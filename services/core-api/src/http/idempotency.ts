import { createHash } from 'node:crypto';
import type { Tx } from '../db/pool.js';
import { HttpProblem } from './problem.js';

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export function requestHash(parts: ReadonlyArray<string | Buffer>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\u0000');
  return h.digest('hex');
}

export function idempotencyKeyOf(header: string | string[] | undefined): string {
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length < 16 || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new HttpProblem(400, 'Idempotency-Key required', 'send an Idempotency-Key header of 16 to 128 printable characters');
  }
  return key;
}

/**
 * Run `work` once per (tenant, key). The key row is inserted in the same
 * transaction as the work, so a concurrent retry blocks on it and then sees the
 * stored response; a failed attempt rolls back and leaves the key free to retry.
 */
export async function idempotent(
  tx: Tx,
  tenantId: string,
  key: string,
  hash: string,
  work: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const inserted = await tx.query(
    'INSERT INTO idempotency_keys (tenant_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tenantId, key, hash],
  );
  if (inserted.rowCount === 0) {
    const { rows } = await tx.query<{ request_hash: string; status_code: number | null; response: unknown }>(
      'SELECT request_hash, status_code, response FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
      [tenantId, key],
    );
    const row = rows[0];
    if (!row || row.request_hash !== hash) {
      throw new HttpProblem(422, 'Idempotency-Key reused', 'this Idempotency-Key was already used for a different request', 'IDEMPOTENCY_KEY_REUSED');
    }
    if (row.status_code === null) throw new HttpProblem(409, 'Request in progress', 'a request with this Idempotency-Key is still running');
    return { status: row.status_code, body: row.response, replayed: true };
  }
  const out = await work();
  await tx.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE tenant_id = $1 AND key = $2', [
    tenantId,
    key,
    out.status,
    JSON.stringify(out.body),
  ]);
  return { ...out, replayed: false };
}
