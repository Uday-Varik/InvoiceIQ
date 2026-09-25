import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// bigint columns (int8) come back as strings; money code parses them explicitly with BigInt.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
// DATE stays YYYY-MM-DD; a JS Date would shift it by the server's time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPool(connectionString: string, opts: { max?: number } = {}): Db {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 5,
    // Serverless Postgres drops idle connections; do not hold them for long.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction scoped to one tenant. `app.tenant_id` is set with
 * SET LOCAL semantics (set_config(..., true)), so it cannot leak to the next
 * user of the pooled connection, and RLS filters every statement (ADR-0004).
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('withTenant: tenantId must be a UUID');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** A transaction with no tenant set: RLS returns no tenant rows. Used only by the outbox claim. */
export async function withoutTenant<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
