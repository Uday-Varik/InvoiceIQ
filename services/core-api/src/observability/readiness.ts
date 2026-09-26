import type { Db } from '../db/pool.js';

/**
 * /readyz: can this instance serve real traffic? Postgres must answer and
 * every migration this build ships must be applied. ai-service is reported but
 * never makes core-api unready: it scales to zero, and the outbox absorbs its
 * cold start (ADR-0008), so an uptime monitor should not page on it.
 */

export interface CheckResult {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly checks: {
    readonly database: CheckResult;
    readonly migrations: CheckResult & { readonly applied?: number; readonly expected: number };
    readonly aiService: CheckResult & { readonly required: false };
  };
}

export interface ReadinessDeps {
  readonly db: Pick<Db, 'query'>;
  /** Migration ids this build expects, e.g. ['0001', '0002']. */
  readonly expectedMigrations: readonly string[];
  /** Resolves true when ai-service answered its health check. */
  readonly aiPing?: () => Promise<boolean>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function reason(err: unknown): string {
  // Never echo connection strings or server messages to an unauthenticated caller.
  return err instanceof TimeoutError ? err.message : 'unavailable';
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessReport> {
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const now = deps.now ?? (() => performance.now());
  const expected = deps.expectedMigrations.length;

  const dbStart = now();
  let database: CheckResult;
  let migrations: ReadinessReport['checks']['migrations'];
  try {
    const { rows } = await withTimeout(deps.db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id'), timeoutMs);
    database = { ok: true, latencyMs: Math.round(now() - dbStart) };
    const applied = new Set(rows.map((r) => r.id));
    const missing = deps.expectedMigrations.filter((id) => !applied.has(id));
    migrations = missing.length
      ? { ok: false, applied: applied.size, expected, detail: `not applied: ${missing.join(', ')}` }
      : { ok: true, applied: applied.size, expected };
  } catch (err) {
    database = { ok: false, latencyMs: Math.round(now() - dbStart), detail: reason(err) };
    migrations = { ok: false, expected, detail: 'database unavailable' };
  }

  let aiService: ReadinessReport['checks']['aiService'];
  if (!deps.aiPing) {
    aiService = { ok: false, required: false, detail: 'not configured' };
  } else {
    const aiStart = now();
    try {
      const ok = await withTimeout(deps.aiPing(), timeoutMs);
      aiService = { ok, required: false, latencyMs: Math.round(now() - aiStart), ...(ok ? {} : { detail: 'asleep or unreachable' }) };
    } catch (err) {
      aiService = { ok: false, required: false, latencyMs: Math.round(now() - aiStart), detail: reason(err) };
    }
  }

  return { status: database.ok && migrations.ok ? 'ready' : 'not_ready', checks: { database, migrations, aiService } };
}
