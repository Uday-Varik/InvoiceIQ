/**
 * Currencies without two decimals on real Postgres: a yen and a dinar invoice
 * flow through validation, the summary and the CSV export in their own minor
 * units, and a tenant that does not enable a currency still gets an EXCEPTION.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootstrapTenant, DEMO_TENANT_ID } from '../../src/db/bootstrap.js';
import { CSV_COLUMNS } from '../../src/invoices/export.js';
import { AiStub, GOOD_FIELDS, type StubFields } from '../support/ai-stub.js';
import { harness, key, multipart, type Harness } from '../support/app.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';
import { uniquePdf } from '../support/fixtures.js';

const f = (value: string | null, confidence = 0.95) => ({ value, confidence });

const YEN: StubFields = { ...GOOD_FIELDS, invoiceNumber: f('KP-7731'), currency: f('JPY'), totalMinor: f('35200'), subtotalMinor: f('32000'), taxMinor: f('3200') };
const DINAR: StubFields = { ...GOOD_FIELDS, invoiceNumber: f('BH-1'), currency: f('BHD'), totalMinor: f('27500'), subtotalMinor: f('25000'), taxMinor: f('2500') };

describeDb('currency exponents (real Postgres)', () => {
  let tdb: TestDatabase;
  let ai: AiStub;
  let h: Harness;

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

  const upload = async (fields: StubFields, lineItems: NonNullable<Extract<AiStub['mode'], { kind: 'fields' }>['lineItems']> = []) => {
    ai.mode = { kind: 'fields', fields, lineItems };
    const mp = multipart(uniquePdf(`cur-${randomUUID()}`), 'scan.pdf');
    const res = await h.app.inject({ method: 'POST', url: '/v1/invoices', payload: mp.payload, headers: { ...mp.headers, 'idempotency-key': key() } });
    expect(res.statusCode).toBe(201);
    await h.worker.drain();
    return (await h.app.inject({ method: 'GET', url: `/v1/invoices/${res.json().id}` })).json();
  };
  const csvRows = async (query: string) => {
    const res = await h.app.inject({ method: 'GET', url: `/v1/invoices/export?${query}` });
    expect(res.statusCode).toBe(200);
    const [, ...rows] = res.body.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    return rows.map((r) => Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, r.split(',')[i]])));
  };

  it('a yen invoice whose lines and tax add up in whole yen passes validation', async () => {
    const inv = await upload(YEN, [{ description: 'Bearings 6204', quantity: '40', unitPriceMinor: '800', amountMinor: '32000', confidence: 0.85 }]);
    expect(inv.reasons).toEqual([]);
    expect(inv.state).toBe('PENDING_APPROVAL');
    expect(inv.total).toEqual({ amountMinor: '35200', currency: 'JPY' });
  });

  it('a yen invoice that does not add up is still caught', async () => {
    const inv = await upload({ ...YEN, invoiceNumber: f('KP-7732'), totalMinor: f('35300') });
    expect(inv.state).toBe('EXCEPTION');
  });

  it('exports yen without decimals and dinars with three', async () => {
    await upload(DINAR);
    const [yen] = await csvRows('currency=JPY&q=KP-7731');
    expect(yen).toMatchObject({ currency: 'JPY', subtotal: '32000', tax: '3200', total: '35200', total_minor: '35200' });
    const [dinar] = await csvRows('currency=BHD');
    expect(dinar).toMatchObject({ currency: 'BHD', subtotal: '25.000', tax: '2.500', total: '27.500', total_minor: '27500' });
  });

  it('the summary keeps each currency in its own minor units', async () => {
    const summary = (await h.app.inject({ method: 'GET', url: '/v1/invoices/summary?currency=BHD' })).json();
    expect(summary.byCurrency).toEqual([{ currency: 'BHD', count: 1, amountMinor: '27500' }]);
  });

  it('a currency the tenant does not enable is still an EXCEPTION', async () => {
    const inv = await upload({ ...YEN, invoiceNumber: f('KW-1'), currency: f('KWD') });
    expect(inv.reasons).toEqual(['VALIDATION_CURRENCY_UNSUPPORTED']);
  });
});
