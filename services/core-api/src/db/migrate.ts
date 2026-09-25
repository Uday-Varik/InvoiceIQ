import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Minimal forward-only SQL migrator. Files in migrations/ named NNNN_name.sql
 * run once, in order, each in its own transaction, under an advisory lock so
 * two booting instances cannot race. A changed checksum on an applied file is
 * an error: migrations are immutable once shipped.
 */

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');
const LOCK_KEY = 4_231_870_001;
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
  readonly id: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.map((name) => {
    const m = FILE_RE.exec(name);
    if (!m?.[1]) throw new Error(`bad migration file name: ${name}`);
    const sql = readFileSync(join(dir, name), 'utf8');
    return { id: m[1], name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

export async function migrate(connectionString: string, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = loadMigrations(dir);
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.id, r.checksum]));
    for (const m of migrations) {
      const prior = done.get(m.id);
      if (prior !== undefined) {
        if (prior !== m.checksum) throw new Error(`migration ${m.name} changed after it was applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)', [m.id, m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return applied;
}
