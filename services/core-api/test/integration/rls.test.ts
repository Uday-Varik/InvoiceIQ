/**
 * ADR-0004 acceptance: connect as the app role and prove tenant isolation holds
 * in the database itself, independent of any WHERE clause in application code.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootstrapTenant } from '../../src/db/bootstrap.js';
import { createPool, withTenant, withoutTenant, type Db } from '../../src/db/pool.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';

const A = randomUUID();
const B = randomUUID();
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describeDb('row-level security (real Postgres, app role)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let invA: string;
  let invB: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await bootstrapTenant(tdb.ownerUrl, { id: A, name: 'Tenant A' });
    await bootstrapTenant(tdb.ownerUrl, { id: B, name: 'Tenant B' });
    db = createPool(tdb.appUrl);
    const seed = async (tenant: string, sha: string) =>
      withTenant(db, tenant, async (tx) => {
        const id = randomUUID();
        await tx.query("INSERT INTO documents (tenant_id, sha256, content_type, size_bytes, content) VALUES ($1, $2, 'application/pdf', 3, 'pdf')", [tenant, sha]);
        await tx.query(
          "INSERT INTO invoices (id, tenant_id, state, source_channel, document_sha256, document_filename, created_by) VALUES ($1, $2, 'RECEIVED', 'upload', $3, 'x.pdf', 'u')",
          [id, tenant, sha],
        );
        await tx.query("INSERT INTO outbox (tenant_id, event_id, topic, payload) VALUES ($1, $2, 'invoice.received', '{}')", [tenant, randomUUID()]);
        return id;
      });
    invA = await seed(A, SHA_A);
    invB = await seed(B, SHA_B);
  });

  afterAll(async () => {
    await db?.end();
    await tdb?.drop();
  });

  it('every tenant-owned table has RLS enabled and forced', async () => {
    const owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations' ORDER BY c.relname`,
      );
      expect(rows.map((r) => r.relname)).toEqual(['audit_log', 'documents', 'idempotency_keys', 'invoice_line_items', 'invoices', 'outbox', 'tenant_policies', 'tenants']);
      for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    } finally {
      await owner.end();
    }
  });

  it('the app role is not the owner, not a superuser and cannot bypass RLS', async () => {
    const { rows } = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>(
      `SELECT rolsuper, rolbypassrls,
              EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owns: false });
  });

  it('with no tenant set, every table reads as empty (fail closed)', async () => {
    await withoutTenant(db, async (tx) => {
      for (const table of ['tenants', 'tenant_policies', 'documents', 'invoices', 'invoice_line_items', 'audit_log', 'idempotency_keys', 'outbox']) {
        const { rows } = await tx.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0], table).toEqual({ n: 0 });
      }
    });
  });

  it('a tenant sees only its own rows, even when asking for the other id', async () => {
    await withTenant(db, A, async (tx) => {
      expect((await tx.query('SELECT id FROM invoices')).rows).toEqual([{ id: invA }]);
      expect((await tx.query('SELECT id FROM invoices WHERE id = $1', [invB])).rows).toEqual([]);
      expect((await tx.query('SELECT id FROM tenants')).rows).toEqual([{ id: A }]);
      expect((await tx.query('SELECT sha256 FROM documents')).rows).toEqual([{ sha256: SHA_A }]);
    });
  });

  it('cross-tenant updates touch zero rows', async () => {
    await withTenant(db, A, async (tx) => {
      const res = await tx.query("UPDATE invoices SET state = 'APPROVED' WHERE id = $1", [invB]);
      expect(res.rowCount).toBe(0);
    });
    await withTenant(db, B, async (tx) => {
      expect((await tx.query('SELECT state FROM invoices WHERE id = $1', [invB])).rows).toEqual([{ state: 'RECEIVED' }]);
    });
  });

  it('writing a row for another tenant is refused by WITH CHECK', async () => {
    await expect(
      withTenant(db, A, (tx) =>
        tx.query("INSERT INTO documents (tenant_id, sha256, content_type, size_bytes, content) VALUES ($1, $2, 'application/pdf', 1, 'x')", [B, 'c'.repeat(64)]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the tenant setting does not leak to the next transaction on a pooled connection', async () => {
    const single = createPool(tdb.appUrl, { max: 1 });
    try {
      await withTenant(single, A, (tx) => tx.query('SELECT 1'));
      const { rows } = await single.query("SELECT current_setting('app.tenant_id', true) AS t");
      expect(rows[0].t ?? '').toBe('');
      expect((await single.query('SELECT count(*)::int AS n FROM invoices')).rows[0]).toEqual({ n: 0 });
    } finally {
      await single.end();
    }
  });

  it('the app role cannot rewrite or delete audit history, and neither can the owner', async () => {
    await withTenant(db, A, (tx) =>
      tx.query(
        `INSERT INTO audit_log (tenant_id, seq, invoice_id, type, actor, occurred_at, payload, prev_hash, hash)
         VALUES ($1, 0, $2, 't', '{}', now(), '{}', $3, $3)`,
        [A, invA, '0'.repeat(64)],
      ),
    );
    await expect(withTenant(db, A, (tx) => tx.query('UPDATE audit_log SET type = $1', ['x']))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, A, (tx) => tx.query('DELETE FROM audit_log'))).rejects.toThrow(/permission denied/);
    const owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    try {
      await owner.query("SELECT set_config('app.tenant_id', $1, false)", [A]);
      await expect(owner.query("UPDATE audit_log SET type = 'x'")).rejects.toThrow(/append-only/);
      await expect(owner.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
      await expect(owner.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
  });

  it('the app role cannot create tenants or edit policies', async () => {
    await expect(withTenant(db, A, (tx) => tx.query("INSERT INTO tenants (id, name) VALUES ($1, 'x')", [A]))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, A, (tx) => tx.query("UPDATE tenant_policies SET policy = '{}'"))).rejects.toThrow(/permission denied/);
  });

  it('claim_outbox is the one cross-tenant path, and it only leases events', async () => {
    const claimed = await withoutTenant(db, async (tx) => (await tx.query<{ tenant_id: string }>('SELECT * FROM claim_outbox(10, 60)')).rows);
    expect(claimed.map((r) => r.tenant_id).sort()).toEqual([A, B].sort());
    // Leased rows are not handed out twice while the lease holds.
    const again = await withoutTenant(db, async (tx) => (await tx.query('SELECT * FROM claim_outbox(10, 60)')).rows);
    expect(again).toEqual([]);
    // And the app role still cannot read the other tenant's outbox directly.
    await withTenant(db, A, async (tx) => {
      expect((await tx.query('SELECT tenant_id FROM outbox')).rows).toEqual([{ tenant_id: A }]);
    });
  });
});
