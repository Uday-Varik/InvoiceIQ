/**
 * Phase 2 end to end on real Postgres: extracted details (subtotal, tax, due
 * date, line items) are stored, totals are validated, reviewers correct fields
 * before approving, and the dashboard lists, summarises and exports with filters.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as contract from '@invoiceiq/contracts/core-api/zod';
import { demoAuthenticator } from '../../src/auth/auth.js';
import { bootstrapTenant, DEMO_TENANT_ID } from '../../src/db/bootstrap.js';
import { withTenant } from '../../src/db/pool.js';
import { CSV_COLUMNS } from '../../src/invoices/export.js';
import { AiStub, GOOD_FIELDS, GOOD_LINES, type StubFields } from '../support/ai-stub.js';
import { harness, key, multipart, type Harness } from '../support/app.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';
import { uniquePdf } from '../support/fixtures.js';

type Lines = NonNullable<Extract<AiStub['mode'], { kind: 'fields' }>['lineItems']>;
const f = (value: string | null, confidence = 0.95) => ({ value, confidence });
const line = (description: string, amountMinor: string | null, quantity: string | null = null, unitPriceMinor: string | null = null) => ({
  description,
  quantity,
  unitPriceMinor,
  amountMinor,
  confidence: 0.85,
});

/** An invoice that prints subtotal 1000.00 + tax 234.50 = 1234.50 over two lines. */
const DETAILED: StubFields = {
  ...GOOD_FIELDS,
  subtotalMinor: f('100000'),
  taxMinor: f('23450'),
  dueDate: f('2026-04-13'),
};
const DETAILED_LINES: Lines = [line('Hex bolts M8', '40000', '200', '200'), line('Safety gloves', '60000', '40', '1500')];

describeDb('Phase 2 invoice API (real Postgres)', () => {
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

  const uploadWith = async (app: Harness, fields: StubFields, lineItems: Lines = [], filename = 'acme.pdf') => {
    ai.mode = { kind: 'fields', fields, lineItems };
    const mp = multipart(uniquePdf(`p2-${++n}-${randomUUID()}`), filename);
    const res = await app.app.inject({ method: 'POST', url: '/v1/invoices', payload: mp.payload, headers: { ...mp.headers, 'idempotency-key': key() } });
    expect(res.statusCode).toBe(201);
    await app.worker.drain();
    return res.json().id as string;
  };
  const upload = (fields: StubFields = GOOD_FIELDS, lineItems: Lines = []) => uploadWith(h, fields, lineItems);
  const get = async (id: string, app: Harness = h) => (await app.app.inject({ method: 'GET', url: `/v1/invoices/${id}` })).json();
  const patch = (id: string, body: object, idem = key(), app: Harness = h) =>
    app.app.inject({ method: 'PATCH', url: `/v1/invoices/${id}`, payload: body, headers: { 'idempotency-key': idem } });
  const act = (id: string, action: string, body: object, app: Harness = h) =>
    app.app.inject({ method: 'POST', url: `/v1/invoices/${id}/${action}`, payload: body, headers: { 'idempotency-key': key() } });

  describe('extracted details are stored', () => {
    it('subtotal, tax, due date and line items come back on getInvoice, contract-valid', async () => {
      const id = await upload(DETAILED, DETAILED_LINES);
      const inv = contract.Invoice.parse(await get(id));
      expect(inv.state).toBe('PENDING_APPROVAL');
      expect(inv.subtotal).toEqual({ amountMinor: '100000', currency: 'USD' });
      expect(inv.tax).toEqual({ amountMinor: '23450', currency: 'USD' });
      expect(inv.dueDate).toBe('2026-04-13');
      expect(inv.lineItems).toEqual([
        { position: 1, description: 'Hex bolts M8', quantity: '200', unitPriceMinor: '200', amountMinor: '40000' },
        { position: 2, description: 'Safety gloves', quantity: '40', unitPriceMinor: '1500', amountMinor: '60000' },
      ]);
      expect(inv.corrections).toBeUndefined();
    });

    it('the raw extraction keeps the new fields and lines alongside the typed columns', async () => {
      const id = await upload(DETAILED, DETAILED_LINES);
      const inv = contract.Invoice.parse(await get(id));
      expect(inv.extraction?.fields.taxMinor).toEqual({ value: '23450', confidence: 0.95 });
      expect(inv.extraction?.lineItems).toHaveLength(2);
    });

    it('lines that add up to the total with no subtotal pass validation', async () => {
      const id = await upload(GOOD_FIELDS, GOOD_LINES);
      expect((await get(id)).state).toBe('PENDING_APPROVAL');
    });

    it('a printed subtotal plus tax that misses the total is an EXCEPTION with VALIDATION_TOTALS_MISMATCH', async () => {
      const id = await upload({ ...DETAILED, taxMinor: f('20000') });
      const inv = await get(id);
      expect(inv).toMatchObject({ state: 'EXCEPTION', reasons: ['VALIDATION_TOTALS_MISMATCH'] });
      const last = await withTenant(h.db, DEMO_TENANT_ID, async (tx) =>
        (await tx.query<{ payload: { details: { totals: unknown[] } } }>('SELECT payload FROM audit_log WHERE invoice_id = $1 ORDER BY seq DESC LIMIT 1', [id])).rows[0],
      );
      expect(last?.payload.details.totals).toEqual([{ check: 'subtotal_plus_tax', expectedTotalMinor: '120000', totalMinor: '123450' }]);
    });

    it('lines that do not add up to the total are an EXCEPTION', async () => {
      const id = await upload(GOOD_FIELDS, [line('Only line', '100')]);
      expect(await get(id)).toMatchObject({ state: 'EXCEPTION', reasons: ['VALIDATION_TOTALS_MISMATCH'] });
    });

    it('a line with no amount skips the line-sum check instead of guessing', async () => {
      const id = await upload(GOOD_FIELDS, [line('Unknown amount', null)]);
      expect((await get(id)).state).toBe('PENDING_APPROVAL');
    });

    it('an older ai-service that sends no subtotal, tax, due date or lines still works', async () => {
      const old = Object.fromEntries(Object.entries(GOOD_FIELDS).filter(([k]) => !['subtotalMinor', 'taxMinor', 'dueDate'].includes(k)));
      const id = await upload(old as unknown as StubFields);
      const inv = contract.Invoice.parse(await get(id));
      expect(inv.state).toBe('PENDING_APPROVAL');
      expect(inv.lineItems).toEqual([]);
      expect(inv.extraction?.fields.taxMinor).toEqual({ value: null, confidence: 0 });
    });

    it('a malformed extracted due date stays out of the typed column', async () => {
      const id = await upload({ ...GOOD_FIELDS, dueDate: f('13/04/2026') });
      const inv = await get(id);
      expect(inv.dueDate).toBeUndefined();
      expect(inv.extraction.fields.dueDate.value).toBe('13/04/2026');
    });
  });

  describe('edit before approve', () => {
    it('correcting a pending invoice records the change, re-validates, and lands back in PENDING_APPROVAL', async () => {
      const id = await upload();
      const before = await get(id);
      const res = await patch(id, { expectedVersion: before.version, vendorName: 'ACME Industrial Supply Inc.', comment: 'legal name' });
      expect(res.statusCode).toBe(200);
      const inv = contract.Invoice.parse(res.json());
      expect(inv.state).toBe('PENDING_APPROVAL');
      expect(inv.vendorName).toBe('ACME Industrial Supply Inc.');
      expect(inv.corrections).toEqual(['vendorName']);
      expect(inv.version).toBeGreaterThan(before.version);

      const history = contract.Invoice.parse(await get(id)).history ?? [];
      const corrected = history.find((e) => e.type === 'invoice.corrected');
      expect(corrected).toMatchObject({
        actor: { kind: 'human', id: 'demo-user' },
        comment: 'legal name',
        changes: { vendorName: { from: 'ACME Industrial Supply', to: 'ACME Industrial Supply Inc.' } },
      });
      const tail = history.slice(history.indexOf(corrected as (typeof history)[number]) + 1).map((e) => `${e.from}>${e.to}:${e.actor.kind}`);
      expect(tail).toEqual([
        'PENDING_APPROVAL>HOLD:human',
        'HOLD>VALIDATING:human',
        'VALIDATING>VALIDATED:system',
        'VALIDATED>MATCHING:system',
        'MATCHING>MATCHED:system',
        'MATCHED>PENDING_APPROVAL:system',
      ]);
    });

    it('a corrected invoice can then be approved', async () => {
      const id = await upload();
      const v = (await get(id)).version as number;
      await patch(id, { expectedVersion: v, invoiceNumber: 'INV-2026-0042-A' });
      expect((await act(id, 'approve', {})).json()).toMatchObject({ state: 'APPROVED', invoiceNumber: 'INV-2026-0042-A' });
    });

    it('a stale expectedVersion is a 409 VERSION_CONFLICT and changes nothing', async () => {
      const id = await upload();
      const v = (await get(id)).version as number;
      expect((await patch(id, { expectedVersion: v, vendorName: 'First' })).statusCode).toBe(200);
      const second = await patch(id, { expectedVersion: v, vendorName: 'Second' });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await get(id)).vendorName).toBe('First');
    });

    it('an approved invoice cannot be corrected', async () => {
      const id = await upload();
      await act(id, 'approve', {});
      const inv = await get(id);
      const res = await patch(id, { expectedVersion: inv.version, vendorName: 'Too late' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NOT_EDITABLE' });
    });

    it('a correction that changes nothing is a 422 NO_CHANGES', async () => {
      const id = await upload();
      const inv = await get(id);
      const res = await patch(id, { expectedVersion: inv.version, vendorName: inv.vendorName, totalMinor: '123450' });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'NO_CHANGES' });
    });

    it('a due date before the invoice date is a 422', async () => {
      const id = await upload();
      const inv = await get(id);
      const res = await patch(id, { expectedVersion: inv.version, dueDate: '2026-01-01' });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'DUE_BEFORE_INVOICE_DATE' });
    });

    it.each([
      [{ totalMinor: '12.50' }, 'decimal total'],
      [{ invoiceDate: '14/03/2026' }, 'non-ISO date'],
      [{ currency: 'usd' }, 'lower-case currency'],
      [{ lineItems: [{ description: 'x', quantity: '1e3' }] }, 'float quantity'],
      [{ vendorName: '' }, 'empty vendor'],
    ] as Array<[object, string]>)('a malformed body (%j, %s) is a 400', async (body) => {
      const id = await upload();
      const inv = await get(id);
      expect((await patch(id, { expectedVersion: inv.version, ...body })).statusCode).toBe(400);
    });

    it('a calendar-impossible date passes the pattern but is a 422', async () => {
      const id = await upload();
      const inv = await get(id);
      const res = await patch(id, { expectedVersion: inv.version, invoiceDate: '2026-02-30' });
      expect(res.statusCode).toBe(422);
    });

    it('needs an Idempotency-Key, and replays the stored response for the same one', async () => {
      const id = await upload();
      const inv = await get(id);
      const body = { expectedVersion: inv.version, vendorName: 'Replayed Co' };
      const noKey = await h.app.inject({ method: 'PATCH', url: `/v1/invoices/${id}`, payload: body });
      expect(noKey.statusCode).toBe(400);
      const idem = key();
      const first = await patch(id, body, idem);
      const again = await patch(id, body, idem);
      expect(again.statusCode).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual(first.json());
      expect((await patch(id, { ...body, vendorName: 'Other' }, idem)).json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('an unknown invoice is a 404', async () => {
      expect((await patch(randomUUID(), { expectedVersion: 1, vendorName: 'x' })).statusCode).toBe(404);
    });

    it('fixing the numbers of a totals EXCEPTION sends it to approval', async () => {
      const id = await upload({ ...DETAILED, taxMinor: f('20000') });
      const inv = await get(id);
      expect(inv.state).toBe('EXCEPTION');
      const res = await patch(id, { expectedVersion: inv.version, taxMinor: '23450' });
      expect(res.json()).toMatchObject({ state: 'PENDING_APPROVAL', reasons: [], tax: { amountMinor: '23450' }, corrections: ['tax'] });
    });

    it('a correction that breaks the arithmetic lands in EXCEPTION', async () => {
      const id = await upload(DETAILED, DETAILED_LINES);
      const inv = await get(id);
      const res = await patch(id, { expectedVersion: inv.version, totalMinor: '999999' });
      expect(res.json()).toMatchObject({ state: 'EXCEPTION', reasons: ['VALIDATION_TOTALS_MISMATCH'] });
    });

    it('a human correcting an AI low-confidence hold sends it on without re-asking the AI', async () => {
      const id = await upload({ ...GOOD_FIELDS, totalMinor: f('123450', 0.4) });
      const held = await get(id);
      expect(held).toMatchObject({ state: 'HOLD', reasons: ['AI_EXTRACTION_LOW_CONFIDENCE'] });
      const signalCalls = ai.calls.filter((c) => c.path === '/v1/signals').length;
      const res = await patch(id, { expectedVersion: held.version, totalMinor: '123400' });
      expect(res.json()).toMatchObject({ state: 'PENDING_APPROVAL', total: { amountMinor: '123400' } });
      expect(ai.calls.filter((c) => c.path === '/v1/signals').length).toBe(signalCalls);
    });

    it('line items are replaced, renumbered and normalised', async () => {
      const id = await upload(GOOD_FIELDS, GOOD_LINES);
      const inv = await get(id);
      const res = await patch(id, {
        expectedVersion: inv.version,
        lineItems: [
          { description: '  Hex bolts M8 x 200  ', quantity: '200.000', unitPriceMinor: '206', amountMinor: '41200' },
          { description: 'Safety gloves x 40', quantity: '040', amountMinor: '82250' },
        ],
      });
      expect(res.statusCode).toBe(200);
      const after = contract.Invoice.parse(await get(id));
      expect(after.lineItems).toEqual([
        { position: 1, description: 'Hex bolts M8 x 200', quantity: '200', unitPriceMinor: '206', amountMinor: '41200' },
        { position: 2, description: 'Safety gloves x 40', quantity: '40', amountMinor: '82250' },
      ]);
      expect(after.corrections).toEqual(['lineItems']);
      const ev = after.history?.find((e) => e.type === 'invoice.corrected');
      expect(Object.keys(ev?.changes ?? {})).toEqual(['lineItems']);
    });

    it('removing every line is allowed, and the line-sum check then no longer applies', async () => {
      const id = await upload(GOOD_FIELDS, [line('Only line', '100')]);
      const inv = await get(id);
      expect(inv.state).toBe('EXCEPTION');
      const res = await patch(id, { expectedVersion: inv.version, lineItems: [] });
      expect(res.json()).toMatchObject({ state: 'PENDING_APPROVAL', lineItems: [] });
    });

    it('null clears subtotal, tax and due date', async () => {
      const id = await upload(DETAILED);
      const inv = await get(id);
      const res = await patch(id, { expectedVersion: inv.version, subtotalMinor: null, taxMinor: null, dueDate: null });
      const out = contract.Invoice.parse(res.json());
      expect([out.subtotal, out.tax, out.dueDate]).toEqual([undefined, undefined, undefined]);
      expect(out.corrections).toEqual(['dueDate', 'subtotal', 'tax']);
    });

    it('corrections accumulate across edits, each field listed once', async () => {
      const id = await upload();
      let inv = await get(id);
      inv = (await patch(id, { expectedVersion: inv.version, vendorName: 'A' })).json();
      inv = (await patch(id, { expectedVersion: inv.version, vendorName: 'B', invoiceNumber: 'N-2' })).json();
      expect(inv.corrections).toEqual(['invoiceNumber', 'vendorName']);
    });

    it('raising the total above every tier holds it with APPROVAL_LIMIT_EXCEEDED', async () => {
      const id = await upload();
      const inv = await get(id);
      expect((await patch(id, { expectedVersion: inv.version, totalMinor: '200000000' })).json()).toMatchObject({
        state: 'HOLD',
        reasons: ['APPROVAL_LIMIT_EXCEEDED'],
      });
    });

    it('switching to a currency the tenant does not enable is an EXCEPTION', async () => {
      const id = await upload();
      const inv = await get(id);
      expect((await patch(id, { expectedVersion: inv.version, currency: 'JPY' })).json()).toMatchObject({
        state: 'EXCEPTION',
        reasons: ['VALIDATION_CURRENCY_UNSUPPORTED'],
      });
    });

    it('approval authority follows the corrected total', async () => {
      const clerk = harness(tdb.appUrl, ai, { auth: demoAuthenticator({ tenantId: DEMO_TENANT_ID, userId: 'clerk', roles: ['ap_clerk'] }) });
      try {
        const id = await uploadWith(clerk, { ...GOOD_FIELDS, totalMinor: f('50000') });
        const inv = await get(id, clerk);
        const res = await patch(id, { expectedVersion: inv.version, totalMinor: '150000' }, key(), clerk);
        expect(res.json().state).toBe('PENDING_APPROVAL');
        const denied = await act(id, 'approve', {}, clerk);
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({ code: 'ROLE_INSUFFICIENT' });
      } finally {
        await clerk.close();
      }
    });

    it('the audit chain still verifies after corrections', async () => {
      const body = contract.AuditVerification.parse((await h.app.inject({ method: 'GET', url: '/v1/audit/verify' })).json());
      expect(body.ok).toBe(true);
    });
  });

  it('a human sending a hold back to VALIDATING gets it validated now, not parked', async () => {
    const id = await upload({ ...GOOD_FIELDS, totalMinor: f('123450', 0.4) });
    const res = await act(id, 'transitions', { to: 'VALIDATING', comment: 're-check' });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('PENDING_APPROVAL');
  });

  describe('dashboard: filters, summary and export', () => {
    const TENANT = randomUUID();
    let d: Harness;
    const ids: Record<string, string> = {};
    const list = async (qs: string) => {
      const res = await d.app.inject({ method: 'GET', url: `/v1/invoices?${qs}` });
      expect(res.statusCode, res.body).toBe(200);
      return contract.InvoicePage.parse(res.json());
    };
    const numbers = async (qs: string) => (await list(qs)).items.map((i) => i.invoiceNumber).sort();

    beforeAll(async () => {
      await bootstrapTenant(tdb.ownerUrl, { id: TENANT, name: 'Dashboard' });
      d = harness(tdb.appUrl, ai, { auth: demoAuthenticator({ tenantId: TENANT, userId: 'dash', roles: ['cfo'] }) });
      const seed = async (name: string, vendor: string, num: string, date: string, currency: string, total: string, file = 'inv.pdf') => {
        ids[name] = await uploadWith(
          d,
          { ...GOOD_FIELDS, vendorName: f(vendor), invoiceNumber: f(num), invoiceDate: f(date), currency: f(currency), totalMinor: f(total) },
          [],
          file,
        );
      };
      await seed('acme', 'ACME Industrial Supply', 'INV-A1', '2026-01-10', 'USD', '123450', 'acme-jan.pdf');
      await seed('northwind', 'Northwind Traders', 'NW-2', '2026-02-15', 'EUR', '240000');
      await seed('globex', 'Globex 50% Off Co', 'GX-3', '2026-03-01', 'USD', '5000');
      await seed('initech', 'Initech', 'IT-4', '2026-03-20', 'INR', '99900');
      await seed('umbrella', 'Umbrella Corp', 'UM-5', '2026-04-05', 'USD', '500000000');
      await seed('evil', '=HYPERLINK("http://evil.example")', 'EV-6', '2026-04-06', 'GBP', '100');
      const rej = await act(ids['initech'] as string, 'reject', { reasons: ['DUPLICATE_EXACT'] }, d);
      expect(rej.statusCode).toBe(200);
    });

    afterAll(async () => {
      await d?.close();
    });

    it('no filter lists the tenant’s six invoices, newest first', async () => {
      const page = await list('');
      expect(page.items.map((i) => i.invoiceNumber)).toEqual(['EV-6', 'UM-5', 'IT-4', 'GX-3', 'NW-2', 'INV-A1']);
    });

    it.each([
      ['q=northwind', ['NW-2']],
      ['q=NORTHWIND', ['NW-2']],
      ['q=inv-a', ['INV-A1']],
      ['q=acme-jan', ['INV-A1']],
      ['q=50%25', ['GX-3']],
      ['q=%25', ['GX-3']],
      ['q=_', []],
      ['currency=USD', ['GX-3', 'INV-A1', 'UM-5']],
      ['dateFrom=2026-03-01', ['EV-6', 'GX-3', 'IT-4', 'UM-5']],
      ['dateTo=2026-02-15', ['INV-A1', 'NW-2']],
      ['dateFrom=2026-02-15&dateTo=2026-03-20', ['GX-3', 'IT-4', 'NW-2']],
      ['minTotalMinor=100000', ['INV-A1', 'NW-2', 'UM-5']],
      ['maxTotalMinor=5000', ['EV-6', 'GX-3']],
      ['minTotalMinor=5000&maxTotalMinor=123450', ['GX-3', 'INV-A1', 'IT-4']],
      ['state=REJECTED', ['IT-4']],
      ['state=HOLD', ['UM-5']],
      ['state=PENDING_APPROVAL&currency=USD', ['GX-3', 'INV-A1']],
      ['state=PENDING_APPROVAL&currency=USD&q=globex&dateFrom=2026-03-01&maxTotalMinor=5000', ['GX-3']],
    ])('%s', async (qs, expected) => {
      expect(await numbers(qs)).toEqual([...expected].sort());
    });

    it.each([
      ['dateFrom=2026-03-01&dateTo=2026-01-01', 'INVALID_FILTER'],
      ['dateFrom=2026-02-30', 'INVALID_FILTER'],
      ['minTotalMinor=10&maxTotalMinor=5', 'INVALID_FILTER'],
    ])('%s is a 400 %s', async (qs, code) => {
      const res = await d.app.inject({ method: 'GET', url: `/v1/invoices?${qs}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code });
    });

    it.each(['currency=usd', 'minTotalMinor=1.5', 'dateTo=March', `q=${'x'.repeat(101)}`, 'state=NOPE'])('%s fails validation', async (qs) => {
      expect((await d.app.inject({ method: 'GET', url: `/v1/invoices?${qs}` })).statusCode).toBe(400);
    });

    it('paginates a filtered list without repeating or skipping', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(`currency=USD&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        seen.push(...page.items.map((i) => i.invoiceNumber ?? ''));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['UM-5', 'GX-3', 'INV-A1']);
    });

    it('list items do not carry line items or history (those are per-invoice)', async () => {
      const page = await list('limit=1');
      expect(page.items[0]?.lineItems).toBeUndefined();
      expect(page.items[0]?.history).toBeUndefined();
    });

    it('summary counts every state in lifecycle order and sums per currency', async () => {
      const res = await d.app.inject({ method: 'GET', url: '/v1/invoices/summary' });
      const s = contract.InvoiceSummary.parse(res.json());
      expect(s.count).toBe(6);
      expect(s.byState.map((r) => r.state)).toEqual(contract.InvoiceState.options);
      const counts = Object.fromEntries(s.byState.filter((r) => r.count > 0).map((r) => [r.state, r.count]));
      expect(counts).toEqual({ PENDING_APPROVAL: 4, REJECTED: 1, HOLD: 1 });
      expect(s.byCurrency).toEqual([
        { currency: 'EUR', count: 1, amountMinor: '240000' },
        { currency: 'GBP', count: 1, amountMinor: '100' },
        { currency: 'INR', count: 1, amountMinor: '99900' },
        { currency: 'USD', count: 3, amountMinor: '500128450' },
      ]);
    });

    it('summary applies the same filters as the list', async () => {
      const s = contract.InvoiceSummary.parse((await d.app.inject({ method: 'GET', url: '/v1/invoices/summary?currency=USD&state=PENDING_APPROVAL' })).json());
      expect(s.count).toBe(2);
      expect(s.byCurrency).toEqual([{ currency: 'USD', count: 2, amountMinor: '128450' }]);
    });

    it('summary rejects a bad filter', async () => {
      expect((await d.app.inject({ method: 'GET', url: '/v1/invoices/summary?dateFrom=2026-13-01' })).statusCode).toBe(400);
    });

    it('CSV export: attachment, BOM, header and one row per invoice', async () => {
      const res = await d.app.inject({ method: 'GET', url: '/v1/invoices/export' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"$/);
      expect(res.headers['x-export-truncated']).toBe('false');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.startsWith('\uFEFF')).toBe(true);
      const rows = res.body.slice(1).trimEnd().split('\r\n');
      expect(rows[0]).toBe(CSV_COLUMNS.join(','));
      expect(rows).toHaveLength(7);
      expect(rows.find((r) => r.includes('INV-A1'))).toContain(',2026-01-10,,USD,,,1234.50,123450,0,,upload,acme-jan.pdf,');
    });

    it('CSV export neutralises a formula smuggled in as a vendor name', async () => {
      const res = await d.app.inject({ method: 'GET', url: '/v1/invoices/export?q=EV-6' });
      const row = res.body.slice(1).trimEnd().split('\r\n')[1] ?? '';
      expect(row).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
      expect(row).not.toMatch(/,=/);
    });

    it('CSV export of a rejected invoice carries its reasons', async () => {
      const res = await d.app.inject({ method: 'GET', url: '/v1/invoices/export?state=REJECTED' });
      expect(res.body).toContain(`${ids['initech']},REJECTED,DUPLICATE_EXACT,Initech,IT-4`);
    });

    it('JSON export is contract-valid and includes line items', async () => {
      const res = await d.app.inject({ method: 'GET', url: '/v1/invoices/export?format=json&currency=USD' });
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toMatch(/\.json"$/);
      const body = contract.InvoiceExport.parse(res.json());
      expect(body).toMatchObject({ count: 3, truncated: false });
      expect(body.items.every((i) => Array.isArray(i.lineItems))).toBe(true);
    });

    it('export flags truncation when more rows match than the limit', async () => {
      const res = await d.app.inject({ method: 'GET', url: '/v1/invoices/export?format=json&limit=2' });
      expect(res.headers['x-export-truncated']).toBe('true');
      expect(contract.InvoiceExport.parse(res.json())).toMatchObject({ count: 2, truncated: true });
    });

    it.each(['format=xml', 'limit=0', 'limit=10001', 'dateFrom=2026-05-01&dateTo=2026-04-01'])('export with %s is a 400', async (qs) => {
      expect((await d.app.inject({ method: 'GET', url: `/v1/invoices/export?${qs}` })).statusCode).toBe(400);
    });

    it('another tenant sees none of these in list, summary or export', async () => {
      const other = harness(tdb.appUrl, ai, { auth: demoAuthenticator({ tenantId: randomUUID(), userId: 'x', roles: ['cfo'] }) });
      try {
        expect((await other.app.inject({ method: 'GET', url: '/v1/invoices?q=northwind' })).json().items).toEqual([]);
        expect((await other.app.inject({ method: 'GET', url: '/v1/invoices/summary' })).json()).toMatchObject({ count: 0, byCurrency: [] });
        expect((await other.app.inject({ method: 'GET', url: '/v1/invoices/export?format=json' })).json()).toMatchObject({ count: 0 });
      } finally {
        await other.close();
      }
    });
  });

  it('line items are isolated per tenant by RLS, whatever the query asks for', async () => {
    const id = await upload(DETAILED, DETAILED_LINES);
    const other = randomUUID();
    await bootstrapTenant(tdb.ownerUrl, { id: other, name: 'Other' });
    const seen = await withTenant(h.db, other, async (tx) => (await tx.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [id])).rowCount);
    expect(seen).toBe(0);
    const own = await withTenant(h.db, DEMO_TENANT_ID, async (tx) => (await tx.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [id])).rowCount);
    expect(own).toBe(2);
    await expect(
      withTenant(h.db, other, (tx) =>
        tx.query("INSERT INTO invoice_line_items (tenant_id, invoice_id, position, description) VALUES ($1, $2, 9, 'smuggled')", [DEMO_TENANT_ID, id]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
