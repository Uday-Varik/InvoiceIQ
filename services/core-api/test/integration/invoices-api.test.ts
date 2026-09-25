/** The walking skeleton end to end: upload -> extract -> validate -> approve, on real Postgres. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as contract from '@invoiceiq/contracts/core-api/zod';
import { bootstrapTenant, DEMO_TENANT_ID } from '../../src/db/bootstrap.js';
import { withTenant } from '../../src/db/pool.js';
import { AiStub, GOOD_FIELDS } from '../support/ai-stub.js';
import { harness, key, multipart, type Harness } from '../support/app.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';
import { SAMPLE_PDF, uniquePdf } from '../support/fixtures.js';

describeDb('invoice API (real Postgres, stubbed ai-service over signed HTTP)', () => {
  let tdb: TestDatabase;
  let ai: AiStub;
  let h: Harness;
  let n = 0;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await bootstrapTenant(tdb.ownerUrl, { id: DEMO_TENANT_ID, name: 'Demo' });
    ai = await new AiStub().start();
    h = harness(tdb.appUrl, ai, { maxAttempts: 2 });
  });

  afterAll(async () => {
    await h?.close();
    await ai?.stop();
    await tdb?.drop();
  });

  beforeEach(() => {
    ai.mode = { kind: 'fields', fields: GOOD_FIELDS };
  });

  const upload = async (file: Buffer = uniquePdf(`t${++n}`), idem = key()) => {
    const mp = multipart(file, 'acme.pdf');
    return h.app.inject({ method: 'POST', url: '/v1/invoices', payload: mp.payload, headers: { ...mp.headers, 'idempotency-key': idem } });
  };
  const get = async (id: string) => (await h.app.inject({ method: 'GET', url: `/v1/invoices/${id}` })).json();
  const act = (id: string, action: string, body: object, idem = key()) =>
    h.app.inject({ method: 'POST', url: `/v1/invoices/${id}/${action}`, payload: body, headers: { 'idempotency-key': idem } });

  it('happy path: upload lands in RECEIVED, the drain walks it to PENDING_APPROVAL, a human approves', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    const created = contract.Invoice.parse(res.json());
    expect(created.state).toBe('RECEIVED');
    expect(created.document).toMatchObject({ contentType: 'application/pdf', filename: 'acme.pdf' });

    await h.worker.drain();
    const pending = contract.Invoice.parse(await get(created.id));
    expect(pending.state).toBe('PENDING_APPROVAL');
    expect(pending).toMatchObject({ vendorName: 'ACME Industrial Supply', invoiceNumber: 'INV-2026-0042', invoiceDate: '2026-03-14' });
    expect(pending.total).toEqual({ amountMinor: '123450', currency: 'USD' });
    expect(pending.extraction?.provider).toBe('stub');
    expect(pending.history?.map((e) => e.to ?? e.type)).toEqual([
      'RECEIVED',
      'EXTRACTING',
      'invoice.extracted',
      'EXTRACTED',
      'VALIDATING',
      'VALIDATED',
      'MATCHING',
      'MATCHED',
      'PENDING_APPROVAL',
    ]);
    expect(ai.calls.filter((c) => c.path !== '/healthz').every((c) => c.signed)).toBe(true);

    const approved = await act(created.id, 'approve', { comment: 'looks right' });
    expect(approved.statusCode).toBe(200);
    const body = contract.Invoice.parse(approved.json());
    expect(body.state).toBe('APPROVED');
    const last = (await get(created.id)).history.at(-1);
    expect(last).toMatchObject({ from: 'PENDING_APPROVAL', to: 'APPROVED', actor: { kind: 'human', id: 'demo-user' }, comment: 'looks right' });
  });

  it('the audit chain verifies after a full run', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/audit/verify' });
    const body = contract.AuditVerification.parse(res.json());
    expect(body.ok).toBe(true);
    expect(body.entries).toBeGreaterThan(9);
  });

  it('low extraction confidence is held by the AI actor, and only a human releases it', async () => {
    ai.mode = { kind: 'fields', fields: { ...GOOD_FIELDS, totalMinor: { value: '123450', confidence: 0.4 } } };
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    const held = await get(id);
    expect(held.state).toBe('HOLD');
    expect(held.reasons).toEqual(['AI_EXTRACTION_LOW_CONFIDENCE']);
    expect(held.history.at(-1)).toMatchObject({ to: 'HOLD', actor: { kind: 'ai', id: 'ai-service' } });

    // A hold cannot be approved directly...
    expect((await act(id, 'approve', {})).statusCode).toBe(409);
    // ...but a human can send it on to approval, then approve.
    const released = await act(id, 'transitions', { to: 'PENDING_APPROVAL', comment: 'checked the total by hand' });
    expect(released.statusCode).toBe(200);
    expect(released.json().reasons).toEqual([]);
    expect((await act(id, 'approve', {})).json().state).toBe('APPROVED');
  });

  it('an unsupported currency becomes an EXCEPTION, and malformed values never reach typed columns', async () => {
    ai.mode = { kind: 'fields', fields: { ...GOOD_FIELDS, invoiceDate: { value: 'not-a-date', confidence: 0.95 }, currency: { value: 'XYZ', confidence: 0.95 } } };
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    const inv = await get(id);
    expect(inv.state).toBe('EXCEPTION');
    expect(inv.reasons).toEqual(['VALIDATION_CURRENCY_UNSUPPORTED']);
    expect(inv.invoiceDate).toBeUndefined();
    expect(inv.extraction.fields.invoiceDate.value).toBe('not-a-date');
  });

  it('a confident but unusable required field becomes an EXCEPTION with VALIDATION_MISSING_FIELD', async () => {
    ai.mode = { kind: 'fields', fields: { ...GOOD_FIELDS, invoiceNumber: { value: 'X'.repeat(80), confidence: 0.95 } } };
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    expect(await get(id)).toMatchObject({ state: 'EXCEPTION', reasons: ['VALIDATION_MISSING_FIELD'] });
  });

  it('a total above every approval tier is held with APPROVAL_LIMIT_EXCEEDED', async () => {
    ai.mode = { kind: 'fields', fields: { ...GOOD_FIELDS, totalMinor: { value: '500000000', confidence: 0.95 } } };
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    expect(await get(id)).toMatchObject({ state: 'HOLD', reasons: ['APPROVAL_LIMIT_EXCEEDED'] });
  });

  it('reject needs a reason that allows REJECTED', async () => {
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    const bad = await act(id, 'reject', { reasons: ['DUPLICATE_NEAR'] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: 'REASON_OUTCOME_MISMATCH' });
    expect((await act(id, 'reject', { reasons: [] })).statusCode).toBe(400);
    const ok = await act(id, 'reject', { reasons: ['DUPLICATE_EXACT'], comment: 'paid last month' });
    expect(ok.json()).toMatchObject({ state: 'REJECTED', reasons: ['DUPLICATE_EXACT'] });
    // Terminal: nothing moves it again.
    expect((await act(id, 'transitions', { to: 'HOLD', reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] })).json()).toMatchObject({ code: 'TERMINAL_STATE' });
  });

  it('an unreadable document (ai-service 422) is held for manual review without retries', async () => {
    ai.mode = { kind: 'status', status: 422 };
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    const inv = await get(id);
    expect(inv).toMatchObject({ state: 'HOLD', reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] });
  });

  const pendingOutbox = () =>
    withTenant(h.db, DEMO_TENANT_ID, async (tx) =>
      (
        await tx.query<{ attempts: number; waiting: boolean; last_error: string | null }>(
          `SELECT attempts, available_at > now() AS waiting, last_error FROM outbox
            WHERE topic = 'invoice.received' AND processed_at IS NULL AND dead_at IS NULL`,
        )
      ).rows,
    );
  // Fast-forward the backoff instead of sleeping.
  const skipBackoff = () =>
    withTenant(h.db, DEMO_TENANT_ID, (tx) => tx.query('UPDATE outbox SET available_at = now() WHERE processed_at IS NULL AND dead_at IS NULL'));

  it('ai-service down (cold start or outage): backs off, retries, then holds for manual review', async () => {
    ai.mode = { kind: 'status', status: 503 };
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    expect((await get(id)).state).toBe('EXTRACTING');
    const [row] = await pendingOutbox();
    expect(row).toMatchObject({ attempts: 1, waiting: true });
    expect(row?.last_error).toContain('AiUnavailableError');

    await skipBackoff();
    await h.worker.drain(); // attempt 2 of 2: dead-lettered, invoice held
    expect(await get(id)).toMatchObject({ state: 'HOLD', reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] });
    expect(await pendingOutbox()).toEqual([]);
  });

  it('a recovered ai-service is picked up on the next drain (wake-and-drain)', async () => {
    ai.mode = { kind: 'status', status: 503 };
    const id = (await upload()).json().id as string;
    await h.worker.drain();
    expect((await get(id)).state).toBe('EXTRACTING');
    ai.mode = { kind: 'fields', fields: GOOD_FIELDS };
    await skipBackoff();
    await h.worker.drain();
    expect((await get(id)).state).toBe('PENDING_APPROVAL');
  });

  describe('upload rules', () => {
    it('replays the original response for the same Idempotency-Key', async () => {
      const file = uniquePdf('idem');
      const idem = key();
      const first = await upload(file, idem);
      const second = await upload(file, idem);
      expect(second.statusCode).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json().id).toBe(first.json().id);
    });

    it('refuses the same key for a different document', async () => {
      const idem = key();
      await upload(uniquePdf('k1'), idem);
      const res = await upload(uniquePdf('k2'), idem);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refuses the same bytes twice with 409', async () => {
      const file = uniquePdf('dupe');
      expect((await upload(file)).statusCode).toBe(201);
      const res = await upload(file);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_DOCUMENT');
    });

    it('sniffs the type from the bytes and refuses anything else with 415', async () => {
      const res = await upload(Buffer.from('MZ\x90\x00 definitely not a pdf'));
      expect(res.statusCode).toBe(415);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('refuses documents over the size limit with 413', async () => {
      const res = await upload(Buffer.concat([SAMPLE_PDF, Buffer.alloc(70 * 1024)]));
      expect(res.statusCode).toBe(413);
    });

    it('requires an Idempotency-Key', async () => {
      const mp = multipart(uniquePdf('nokey'));
      const res = await h.app.inject({ method: 'POST', url: '/v1/invoices', payload: mp.payload, headers: mp.headers });
      expect(res.statusCode).toBe(400);
    });

    it('serves the original bytes back', async () => {
      const file = uniquePdf('bytes');
      const id = (await upload(file)).json().id as string;
      const res = await h.app.inject({ method: 'GET', url: `/v1/invoices/${id}/document` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.rawPayload.equals(file)).toBe(true);
    });
  });

  it('lists invoices newest first with keyset pagination', async () => {
    const all = (await h.app.inject({ method: 'GET', url: '/v1/invoices?limit=200' })).json();
    contract.InvoicePage.parse(all);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await h.app.inject({ method: 'GET', url: `/v1/invoices?limit=3${cursor ? `&cursor=${cursor}` : ''}` })).json();
      seen.push(...page.items.map((i: { id: string }) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((i: { id: string }) => i.id));
    const held = (await h.app.inject({ method: 'GET', url: '/v1/invoices?state=HOLD' })).json();
    expect(held.items.length).toBeGreaterThan(0);
    expect(held.items.every((i: { state: string }) => i.state === 'HOLD')).toBe(true);
  });

  it('404s an unknown invoice and 400s a malformed id', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/invoices/00000000-0000-4000-8000-000000000999' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/v1/invoices/not-a-uuid' })).statusCode).toBe(400);
  });
});
