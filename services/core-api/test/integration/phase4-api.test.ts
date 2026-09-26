/**
 * Phase 4 on real Postgres: readiness, queue gauges, one trace from upload to
 * ai-service, metrics after a full flow, and the app-role login step.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as contract from '@invoiceiq/contracts/core-api/zod';
import { setAppRolePassword } from '../../src/db/app-role.js';
import { bootstrapTenant, DEMO_TENANT_ID } from '../../src/db/bootstrap.js';
import { loadMigrations } from '../../src/db/migrate.js';
import { withTenant, withoutTenant } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';
import { createCoreMetrics, type CoreMetrics } from '../../src/observability/catalog.js';
import { parseTraceparent } from '../../src/observability/trace.js';
import { AiStub, GOOD_FIELDS } from '../support/ai-stub.js';
import { harness, key, multipart, type Harness } from '../support/app.js';
import { ADMIN_URL, createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';
import { uniquePdf } from '../support/fixtures.js';

const TRACE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CALLER = `00-${TRACE}-1122334455667788-01`;

describeDb('Phase 4 operations (real Postgres)', () => {
  let tdb: TestDatabase;
  let ai: AiStub;
  let h: Harness;
  let metrics: CoreMetrics;
  let n = 0;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await bootstrapTenant(tdb.ownerUrl, { id: DEMO_TENANT_ID, name: 'Demo' });
    ai = await new AiStub().start();
    metrics = createCoreMetrics({ version: 'test', commit: 'abc' });
    h = harness(tdb.appUrl, ai, { maxAttempts: 2, metrics });
  });

  afterAll(async () => {
    await h?.close();
    await ai?.stop();
    await tdb?.drop();
  });

  const upload = (headers: Record<string, string> = {}) => {
    const mp = multipart(uniquePdf(`p4-${++n}`), 'acme.pdf');
    return h.app.inject({ method: 'POST', url: '/v1/invoices', payload: mp.payload, headers: { ...mp.headers, 'idempotency-key': key(), ...headers } });
  };
  const scrape = async () => (await h.app.inject({ method: 'GET', url: '/metrics' })).body;
  const sample = (text: string, series: string): number | undefined => {
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line === undefined ? undefined : Number(line.slice(series.length + 1));
  };

  describe('readiness', () => {
    it('is ready with every shipped migration applied and ai-service up', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      const body = contract.Readiness.parse(res.json());
      const expected = loadMigrations().length;
      expect(body).toMatchObject({
        status: 'ready',
        checks: { database: { ok: true }, migrations: { ok: true, applied: expected, expected }, aiService: { ok: true, required: false } },
      });
      expect(expected).toBeGreaterThanOrEqual(4);
    });

    it('stays ready while ai-service is down', async () => {
      const app = buildApp({ deps: { db: h.db }, aiPing: async () => false });
      try {
        const res = await app.inject({ method: 'GET', url: '/readyz' });
        expect(res.statusCode).toBe(200);
        expect(res.json().checks.aiService).toMatchObject({ ok: false, required: false });
      } finally {
        await app.close();
      }
    });
  });

  describe('one trace from upload to ai-service', () => {
    it('stores the caller trace on the outbox row and forwards it on the extraction call', async () => {
      const res = await upload({ traceparent: CALLER });
      expect(res.statusCode).toBe(201);
      expect(res.headers['x-trace-id']).toBe(TRACE);
      const id = res.json().id as string;

      const row = await withTenant(h.db, DEMO_TENANT_ID, async (tx) => (await tx.query<{ traceparent: string }>("SELECT traceparent FROM outbox WHERE payload->>'invoiceId' = $1 AND topic = 'invoice.received'", [id])).rows[0]);
      expect(parseTraceparent(row?.traceparent)?.traceId).toBe(TRACE);

      const before = ai.calls.length;
      await h.worker.drain();
      const forwarded = ai.calls.slice(before).filter((c) => c.path !== '/healthz');
      expect(forwarded.length).toBeGreaterThanOrEqual(2);
      for (const call of forwarded) expect(parseTraceparent(call.traceparent)?.traceId, call.path).toBe(TRACE);
    });

    it('starts a fresh trace when the caller sends none, still shared by its extraction', async () => {
      const res = await upload();
      const trace = res.headers['x-trace-id'] as string;
      expect(trace).toMatch(/^[0-9a-f]{32}$/);
      expect(trace).not.toBe(TRACE);
      const before = ai.calls.length;
      await h.worker.drain();
      const traces = new Set(ai.calls.slice(before).filter((c) => c.path !== '/healthz').map((c) => parseTraceparent(c.traceparent)?.traceId));
      expect([...traces]).toEqual([trace]);
    });

    it('refuses a malformed traceparent at the database', async () => {
      await expect(
        withTenant(h.db, DEMO_TENANT_ID, (tx) =>
          tx.query("INSERT INTO outbox (tenant_id, event_id, topic, payload, traceparent) VALUES ($1, gen_random_uuid(), 'invoice.corrected', '{}', 'junk')", [DEMO_TENANT_ID]),
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('claim_outbox hands the traceparent to the worker', async () => {
      await withTenant(h.db, DEMO_TENANT_ID, (tx) =>
        tx.query("INSERT INTO outbox (tenant_id, event_id, topic, payload, traceparent) VALUES ($1, gen_random_uuid(), 'invoice.corrected', '{}', $2)", [DEMO_TENANT_ID, CALLER]),
      );
      const claimed = await withoutTenant(h.db, async (tx) => (await tx.query<{ traceparent: string | null }>('SELECT * FROM claim_outbox(10, 60)')).rows);
      expect(claimed.map((r) => r.traceparent)).toContain(CALLER);
      // Release the lease so later drains process it.
      await withTenant(h.db, DEMO_TENANT_ID, (tx) => tx.query('UPDATE outbox SET locked_until = NULL WHERE processed_at IS NULL'));
      await h.worker.drain();
    });
  });

  describe('metrics after a real flow', () => {
    it('counts committed transitions, ai calls and processed events', async () => {
      await h.worker.drain();
      const text = await scrape();
      expect(sample(text, 'invoiceiq_invoice_transitions_total{to="PENDING_APPROVAL"}')).toBeGreaterThanOrEqual(2);
      expect(sample(text, 'invoiceiq_ai_requests_total{operation="extract_document",outcome="ok"}')).toBeGreaterThanOrEqual(2);
      expect(sample(text, 'invoiceiq_ai_requests_total{operation="signals",outcome="ok"}')).toBeGreaterThanOrEqual(2);
      expect(sample(text, 'invoiceiq_outbox_events_total{topic="invoice.received",outcome="processed"}')).toBeGreaterThanOrEqual(2);
      expect(sample(text, 'invoiceiq_http_requests_total{method="POST",route="/v1/invoices",status="2xx"}')).toBeGreaterThanOrEqual(2);
    });

    it('reads queue gauges across tenants through outbox_stats()', async () => {
      await upload();
      let text = await scrape();
      expect(sample(text, 'invoiceiq_outbox_pending')).toBeGreaterThanOrEqual(1);
      expect(sample(text, 'invoiceiq_outbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(0);
      await h.worker.drain();
      text = await scrape();
      expect(sample(text, 'invoiceiq_outbox_pending')).toBe(0);
      expect(sample(text, 'invoiceiq_outbox_oldest_pending_age_seconds')).toBe(0);
      expect(sample(text, 'invoiceiq_outbox_dead')).toBe(0);
      expect(sample(text, 'invoiceiq_db_pool_connections{state="total"}')).toBeGreaterThanOrEqual(1);
    });

    it('counts a failed extraction as retried, then dead', async () => {
      ai.mode = { kind: 'status', status: 503 };
      try {
        await upload();
        await h.worker.drain();
        await withTenant(h.db, DEMO_TENANT_ID, (tx) => tx.query('UPDATE outbox SET available_at = now() WHERE processed_at IS NULL AND dead_at IS NULL'));
        await h.worker.drain();
      } finally {
        ai.mode = { kind: 'fields', fields: GOOD_FIELDS };
      }
      const text = await scrape();
      expect(sample(text, 'invoiceiq_outbox_events_total{topic="invoice.received",outcome="retried"}')).toBeGreaterThanOrEqual(1);
      expect(sample(text, 'invoiceiq_outbox_events_total{topic="invoice.received",outcome="dead"}')).toBeGreaterThanOrEqual(1);
      expect(sample(text, 'invoiceiq_outbox_dead')).toBeGreaterThanOrEqual(1);
      expect(sample(text, 'invoiceiq_ai_requests_total{operation="extract_document",outcome="unavailable"}')).toBeGreaterThanOrEqual(2);
    });

    it('never puts a tenant or invoice id in a label', async () => {
      const text = await scrape();
      expect(text).not.toContain(DEMO_TENANT_ID);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    });
  });

  describe('app role access added by 0004', () => {
    it('outbox_stats returns counts only, and the app role still sees no rows without a tenant', async () => {
      const stats = await withoutTenant(h.db, async (tx) => (await tx.query('SELECT * FROM outbox_stats()')).rows[0]);
      expect(Object.keys(stats as object).sort()).toEqual(['dead', 'oldest_pending_age_seconds', 'pending']);
      const visible = await withoutTenant(h.db, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM outbox')).rows[0]);
      expect(visible).toEqual({ n: 0 });
    });

    it('can read the migration ledger but not change it', async () => {
      const rows = await withoutTenant(h.db, async (tx) => (await tx.query('SELECT id FROM schema_migrations')).rows);
      expect(rows.length).toBe(loadMigrations().length);
      await expect(withoutTenant(h.db, (tx) => tx.query("DELETE FROM schema_migrations WHERE id = '0004'"))).rejects.toThrow(/permission denied/);
    });
  });
});

describe.runIf(Boolean(ADMIN_URL))('app role login from APP_DB_PASSWORD (real Postgres)', () => {
  let tdb: TestDatabase;
  // Roles are cluster-wide, so this uses a throwaway role instead of the shared invoiceiq_app.
  const probe = `iq_probe_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');

  const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: tdb.ownerUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await asOwner(async (c) => {
      await c.query(`CREATE ROLE ${probe} NOLOGIN`);
      await c.query(`GRANT CONNECT ON DATABASE ${tdb.name} TO ${probe}`);
    });
  });

  afterAll(async () => {
    await tdb?.drop();
    await asOwner(async (c) => c.query(`DROP ROLE IF EXISTS ${probe}`)).catch(() => undefined);
    const admin = new pg.Client({ connectionString: ADMIN_URL as string });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${probe}`).catch(() => undefined);
    await admin.end();
  });

  const loginUrl = (user: string, pw: string) => {
    const u = new URL(tdb.ownerUrl);
    u.username = user;
    u.password = pw;
    return u.toString();
  };

  it('gives the role LOGIN with the configured password, idempotently', async () => {
    await expect(new pg.Client({ connectionString: loginUrl(probe, password) }).connect()).rejects.toThrow();
    await setAppRolePassword(tdb.ownerUrl, password, probe);
    await setAppRolePassword(tdb.ownerUrl, password, probe);
    const c = new pg.Client({ connectionString: loginUrl(probe, password) });
    await c.connect();
    const { rows } = await c.query<{ rolbypassrls: boolean; rolsuper: boolean }>('SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user');
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    await c.end();
  });

  it('rotates the password when the setting changes', async () => {
    // Read the stored verifier as the superuser: local test clusters may trust every password.
    const verifier = async () => {
      const admin = new pg.Client({ connectionString: ADMIN_URL as string });
      await admin.connect();
      try {
        return (await admin.query<{ rolpassword: string }>('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [probe])).rows[0]?.rolpassword;
      } finally {
        await admin.end();
      }
    };
    const before = await verifier();
    const next = randomBytes(18).toString('base64url');
    await setAppRolePassword(tdb.ownerUrl, next, probe);
    const after = await verifier();
    expect(after).toMatch(/^SCRAM-SHA-256\$/);
    expect(after).not.toBe(before);
    const c = new pg.Client({ connectionString: loginUrl(probe, next) });
    await c.connect();
    await c.end();
  });

  it('quotes the password safely', async () => {
    const tricky = `it's'; DROP ROLE ${probe}; --${'x'.repeat(10)}`;
    await setAppRolePassword(tdb.ownerUrl, tricky, probe);
    const c = new pg.Client({ connectionString: loginUrl(probe, tricky) });
    await c.connect();
    await c.end();
  });

  it('refuses a short password or a missing role', async () => {
    await expect(setAppRolePassword(tdb.ownerUrl, 'short', probe)).rejects.toThrow(/at least 24/);
    await expect(setAppRolePassword(tdb.ownerUrl, 'p'.repeat(30), 'iq_no_such_role')).rejects.toThrow(/does not exist/);
  });

  it('refuses to enable login for a role that bypasses RLS', async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL as string });
    await admin.connect();
    const bypass = `${probe}_bypass`;
    try {
      await admin.query(`CREATE ROLE ${bypass} NOLOGIN BYPASSRLS`);
      await expect(setAppRolePassword(tdb.ownerUrl, 'p'.repeat(30), bypass)).rejects.toThrow(/bypasses row-level security/);
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${bypass}`);
      await admin.end();
    }
  });
});
