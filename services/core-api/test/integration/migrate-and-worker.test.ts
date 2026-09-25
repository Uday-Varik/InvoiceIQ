import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootstrapTenant } from '../../src/db/bootstrap.js';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.js';
import { createPool, withTenant, type Db } from '../../src/db/pool.js';
import { enqueue } from '../../src/outbox/enqueue.js';
import { OutboxWorker, type OutboxEvent } from '../../src/outbox/worker.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';

const T = randomUUID();

describeDb('migrations and the outbox worker (real Postgres)', () => {
  let tdb: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await bootstrapTenant(tdb.ownerUrl, { id: T, name: 'T' });
    db = createPool(tdb.appUrl, { max: 8 });
  });

  afterAll(async () => {
    await db?.end();
    await tdb?.drop();
  });

  it('re-running migrations is a no-op', async () => {
    expect(await migrate(tdb.ownerUrl)).toEqual([]);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iq-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    writeFileSync(join(dir, '0001_init.sql'), '-- edited\n', { flag: 'a' });
    await expect(migrate(tdb.ownerUrl, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it('bootstrapping a tenant twice is a no-op', async () => {
    expect(await bootstrapTenant(tdb.ownerUrl, { id: T, name: 'T' })).toEqual({ created: false });
  });

  it('two workers draining at once process every event exactly once', async () => {
    const ids = await withTenant(db, T, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 40; i++) out.push(await enqueue(tx, T, 'invoice.state_changed', { i }));
      return out;
    });
    const seen: string[] = [];
    const handler = async (e: OutboxEvent) => {
      seen.push(e.eventId);
      await new Promise((r) => setTimeout(r, 2));
    };
    const mk = () => new OutboxWorker(db, { handlers: { 'invoice.state_changed': handler }, batchSize: 3 });
    const [a, b] = [mk(), mk()];
    await Promise.all([a.drain(), b.drain()]);
    expect(seen.sort()).toEqual([...ids].sort());
    const left = await withTenant(db, T, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NULL')).rows[0]);
    expect(left).toEqual({ n: 0 });
  });

  it('a failing handler backs off, then dead-letters after maxAttempts and calls onDead once', async () => {
    await withTenant(db, T, (tx) => enqueue(tx, T, 'invoice.received', { invoiceId: 'x' }));
    const dead: OutboxEvent[] = [];
    const w = new OutboxWorker(db, {
      handlers: { 'invoice.received': () => Promise.reject(new Error('boom')) },
      onDead: async (e) => {
        dead.push(e);
      },
      maxAttempts: 3,
      backoff: () => 0,
    });
    await w.drain();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBe(3);
    const row = await withTenant(db, T, async (tx) =>
      (await tx.query("SELECT attempts, dead_at IS NOT NULL AS dead, last_error FROM outbox WHERE topic = 'invoice.received'")).rows[0],
    );
    expect(row).toEqual({ attempts: 3, dead: true, last_error: 'Error: boom' });
  });

  it('an expired lease is reclaimed (a crashed drain does not strand events)', async () => {
    const eventId = await withTenant(db, T, (tx) => enqueue(tx, T, 'invoice.state_changed', { crash: true }));
    // Simulate a worker that claimed the event and died: lease already expired.
    await withTenant(db, T, (tx) => tx.query("UPDATE outbox SET attempts = 1, locked_until = now() - interval '1 second' WHERE event_id = $1", [eventId]));
    const seen: string[] = [];
    await new OutboxWorker(db, { handlers: { 'invoice.state_changed': async (e) => void seen.push(e.eventId) } }).drain();
    expect(seen).toEqual([eventId]);
  });
});
