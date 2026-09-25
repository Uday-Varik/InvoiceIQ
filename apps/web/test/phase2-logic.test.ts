import { describe, expect, it } from 'vitest';
import { correctInvoice, exportUrl, getSummary, listInvoices, type Invoice } from '../lib/api';
import { arithmeticHint, buildCorrection, canCorrect, EMPTY_LINE, formFromInvoice, linesSum, type CorrectionForm } from '../lib/corrections';
import { activeFilterCount, EMPTY_FILTERS, filtersFromSearch, filtersToQuery, filtersToSearch, validateFilters } from '../lib/filters';
import { minorToInput, parseMoneyInput, parseQuantityInput } from '../lib/money';

describe('parseMoneyInput', () => {
  it.each([
    ['1234.50', '123450'],
    ['1,234.50', '123450'],
    ['1,234.5', '123450'],
    ['1234', '123400'],
    ['0.05', '5'],
    ['.5', null],
    ['0', '0'],
    ['-12.30', '-1230'],
    ['-0.00', '0'],
    [' 12 ', '1200'],
    ['1 234.00', '123400'],
    ['12.345', null],
    ['1,23.00', null],
    ['12,34', null],
    ['abc', null],
    ['1e3', null],
    ['', null],
    ['9'.repeat(17), null],
  ])('%j -> %j', (raw, minor) => {
    const r = parseMoneyInput(raw);
    expect(r.ok ? r.minor : null).toBe(minor);
  });
});

describe('minorToInput', () => {
  it.each([
    ['123450', '1234.50'],
    ['5', '0.05'],
    ['-1230', '-12.30'],
    ['0', '0.00'],
  ])('%s -> %s', (minor, out) => expect(minorToInput(minor)).toBe(out));

  it('missing is empty', () => expect([minorToInput(undefined), minorToInput(null), minorToInput('')]).toEqual(['', '', '']));

  it.each(['1234.50', '0.05', '-12.30', '1000000.00'])('round-trips %s', (v) => {
    const r = parseMoneyInput(v);
    expect(r.ok && minorToInput(r.minor)).toBe(v);
  });
});

describe('parseQuantityInput', () => {
  it.each(['1', '2.5', '0.0001', '120'])('%s is a quantity', (q) => expect(parseQuantityInput(q).ok).toBe(true));
  it.each(['-1', '1.23456', '1,000', 'two', ''])('%j is not', (q) => expect(parseQuantityInput(q).ok).toBe(false));
});

describe('dashboard filters', () => {
  it('no filters is an empty query', () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toBe('');
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it('turns amounts into minor units and trims text', () => {
    const q = filtersToQuery({ ...EMPTY_FILTERS, q: '  acme ', currency: 'usd', minTotal: '1,000', maxTotal: '2500.5', state: 'HOLD' });
    expect(Object.fromEntries(new URLSearchParams(q))).toEqual({ state: 'HOLD', q: 'acme', currency: 'USD', minTotalMinor: '100000', maxTotalMinor: '250050' });
  });

  it('dates pass through as ISO days', () => {
    expect(filtersToQuery({ ...EMPTY_FILTERS, dateFrom: '2026-01-01', dateTo: '2026-01-31' })).toBe('dateFrom=2026-01-01&dateTo=2026-01-31');
  });

  it('search text is URL-encoded, so % and & stay literal', () => {
    expect(new URLSearchParams(filtersToQuery({ ...EMPTY_FILTERS, q: '50% & more' })).get('q')).toBe('50% & more');
  });

  it.each([
    [{ currency: 'US' }, 'currency'],
    [{ currency: 'U$D' }, 'currency'],
    [{ dateFrom: '2026-02-01', dateTo: '2026-01-01' }, 'dateTo'],
    [{ minTotal: '12.345' }, 'minTotal'],
    [{ minTotal: '10', maxTotal: '5' }, 'maxTotal'],
    [{ q: 'x'.repeat(101) }, 'q'],
  ])('%j is invalid in %s, and left out of the query', (over, field) => {
    const f = { ...EMPTY_FILTERS, ...over };
    expect(Object.keys(validateFilters(f))).toContain(field);
    const sent = Object.fromEntries(new URLSearchParams(filtersToQuery(f)));
    expect(Object.keys(sent)).not.toContain(field);
  });

  it('a valid set has no errors', () => {
    expect(validateFilters({ ...EMPTY_FILTERS, currency: 'EUR', minTotal: '5', maxTotal: '5', dateFrom: '2026-01-01', dateTo: '2026-01-01' })).toEqual({});
  });

  it('the page URL round-trips human-readable filters', () => {
    const f = { ...EMPTY_FILTERS, state: 'EXCEPTION' as const, q: 'acme', minTotal: '10.50' };
    const search = filtersToSearch(f);
    expect(search).toBe('state=EXCEPTION&q=acme&minTotal=10.50');
    expect(filtersFromSearch(search)).toEqual(f);
    expect(activeFilterCount(f)).toBe(3);
  });

  it('an unknown state in the URL is ignored', () => {
    expect(filtersFromSearch('state=DELETED&q=x')).toEqual({ ...EMPTY_FILTERS, q: 'x' });
  });
});

describe('api client (Phase 2 calls)', () => {
  const recorder = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fn };
  };

  it('lists with filters, a limit and a cursor', async () => {
    const { calls, fn } = recorder(200, { items: [] });
    await listInvoices('state=HOLD&q=acme', { limit: 25, cursor: 'abc' }, fn);
    expect(calls[0]?.url).toBe('/api/core/v1/invoices?state=HOLD&q=acme&limit=25&cursor=abc');
  });

  it('lists 20 by default', async () => {
    const { calls, fn } = recorder(200, { items: [] });
    await listInvoices(undefined, undefined, fn);
    expect(calls[0]?.url).toBe('/api/core/v1/invoices?limit=20');
  });

  it('asks for the summary with the same filters', async () => {
    const { calls, fn } = recorder(200, { count: 0, byState: [], byCurrency: [] });
    await getSummary('currency=USD', fn);
    await getSummary('', fn);
    expect(calls.map((c) => c.url)).toEqual(['/api/core/v1/invoices/summary?currency=USD', '/api/core/v1/invoices/summary']);
  });

  it('export links go through the same-origin proxy with the filters', () => {
    expect(exportUrl('csv', 'state=APPROVED')).toBe('/api/core/v1/invoices/export?state=APPROVED&format=csv');
    expect(exportUrl('json')).toBe('/api/core/v1/invoices/export?format=json');
  });

  it('corrects with PATCH, JSON and the caller’s Idempotency-Key', async () => {
    const { calls, fn } = recorder(200, { id: 'x' });
    await correctInvoice('id/1', { expectedVersion: 3, vendorName: 'A' }, 'web-key-0000000000', fn);
    expect(calls[0]?.url).toBe('/api/core/v1/invoices/id%2F1');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ expectedVersion: 3, vendorName: 'A' });
    expect((calls[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe('web-key-0000000000');
  });
});

const INVOICE: Invoice = {
  id: '0b6f5b1e-3c2d-4e5f-8a9b-0c1d2e3f4a5b',
  tenantId: '5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f',
  state: 'PENDING_APPROVAL',
  reasons: [],
  version: 7,
  vendorName: 'ACME',
  invoiceNumber: 'INV-1',
  invoiceDate: '2026-03-14',
  dueDate: '2026-04-13',
  total: { amountMinor: '123450', currency: 'USD' },
  subtotal: { amountMinor: '100000', currency: 'USD' },
  tax: { amountMinor: '23450', currency: 'USD' },
  lineItems: [
    { position: 1, description: 'Bolts', quantity: '200', unitPriceMinor: '200', amountMinor: '40000' },
    { position: 2, description: 'Gloves', amountMinor: '60000' },
  ],
  createdAt: '2026-03-14T10:00:00.000Z',
  updatedAt: '2026-03-14T10:00:00.000Z',
};

describe('edit before approve: form', () => {
  const form = (over: Partial<CorrectionForm> = {}): CorrectionForm => ({ ...formFromInvoice(INVOICE), ...over });

  it('only waiting states can be corrected', () => {
    expect(['PENDING_APPROVAL', 'HOLD', 'EXCEPTION'].every((s) => canCorrect(s as Invoice['state']))).toBe(true);
    expect(['APPROVED', 'REJECTED', 'EXTRACTING', 'PAID'].some((s) => canCorrect(s as Invoice['state']))).toBe(false);
  });

  it('pre-fills from the invoice in major units', () => {
    expect(formFromInvoice(INVOICE)).toEqual({
      vendorName: 'ACME',
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-03-14',
      dueDate: '2026-04-13',
      currency: 'USD',
      total: '1234.50',
      subtotal: '1000.00',
      tax: '234.50',
      lines: [
        { description: 'Bolts', quantity: '200', unitPrice: '2.00', amount: '400.00' },
        { description: 'Gloves', quantity: '', unitPrice: '', amount: '600.00' },
      ],
      comment: '',
    });
  });

  it('an untouched form changes nothing', () => {
    const r = buildCorrection(INVOICE, form());
    expect(r.ok && r.changed).toEqual([]);
  });

  it('sends only what changed, with the version the reviewer saw', () => {
    const r = buildCorrection(INVOICE, form({ vendorName: ' ACME Inc ', total: '1,234.60', comment: ' typo ' }));
    expect(r.ok && r.body).toEqual({ expectedVersion: 7, vendorName: 'ACME Inc', totalMinor: '123460', comment: 'typo' });
    expect(r.ok && r.changed).toEqual(['vendorName', 'total']);
  });

  it('emptying subtotal, tax or due date sends null to clear them', () => {
    const r = buildCorrection(INVOICE, form({ subtotal: '', tax: '', dueDate: '' }));
    expect(r.ok && r.body).toEqual({ expectedVersion: 7, dueDate: null, subtotalMinor: null, taxMinor: null });
  });

  it('currency is upper-cased', () => {
    const r = buildCorrection(INVOICE, form({ currency: 'eur' }));
    expect(r.ok && r.body).toMatchObject({ currency: 'EUR' });
  });

  it('editing a line sends every line, amounts in minor units', () => {
    const lines = form().lines.map((l, i) => (i === 1 ? { ...l, quantity: '40', unitPrice: '15' } : l));
    const r = buildCorrection(INVOICE, form({ lines }));
    expect(r.ok && r.body.lineItems).toEqual([
      { description: 'Bolts', quantity: '200', unitPriceMinor: '200', amountMinor: '40000' },
      { description: 'Gloves', quantity: '40', unitPriceMinor: '1500', amountMinor: '60000' },
    ]);
  });

  it('"200.00" and "200" are the same quantity, so no change', () => {
    const lines = form().lines.map((l, i) => (i === 0 ? { ...l, quantity: '200.00' } : l));
    const r = buildCorrection(INVOICE, form({ lines }));
    expect(r.ok && r.changed).toEqual([]);
  });

  it('removing a line or adding one is a change', () => {
    const removed = buildCorrection(INVOICE, form({ lines: form().lines.slice(0, 1) }));
    expect(removed.ok && removed.body.lineItems).toHaveLength(1);
    const added = buildCorrection(INVOICE, form({ lines: [...form().lines, { ...EMPTY_LINE, description: 'Freight', amount: '10' }] }));
    expect(added.ok && added.body.lineItems?.at(-1)).toEqual({ description: 'Freight', amountMinor: '1000' });
  });

  it.each([
    [{ vendorName: ' ' }, 'vendorName'],
    [{ invoiceNumber: '' }, 'invoiceNumber'],
    [{ invoiceDate: '' }, 'invoiceDate'],
    [{ dueDate: '2026-01-01' }, 'dueDate'],
    [{ currency: 'dollars' }, 'currency'],
    [{ total: '12.345' }, 'total'],
    [{ tax: 'abc' }, 'tax'],
  ])('%j is refused before any request (%s)', (over, field) => {
    const r = buildCorrection(INVOICE, form(over));
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.errors)).toContain(field);
  });

  it('a bad line names its row', () => {
    const r = buildCorrection(INVOICE, form({ lines: [{ ...EMPTY_LINE }, { ...EMPTY_LINE, description: 'x', quantity: '-1' }] }));
    expect(!r.ok && r.errors.lines).toEqual({ 0: 'Every line needs a description', 1: 'Quantity is a number with up to 4 decimals' });
  });
});

describe('edit before approve: arithmetic hint', () => {
  const base = formFromInvoice(INVOICE);

  it('no hint when subtotal + tax and the lines both add up', () => {
    expect(arithmeticHint(base)).toBeUndefined();
  });

  it('flags subtotal + tax that miss the total', () => {
    expect(arithmeticHint({ ...base, tax: '200.00' })).toBe('Subtotal + tax is 1200.00, not 1234.50');
  });

  it('flags lines that miss the total', () => {
    expect(arithmeticHint({ ...base, subtotal: '', lines: [{ ...EMPTY_LINE, description: 'x', amount: '1' }] })).toBe('Lines + tax is 235.50, not 1234.50');
  });

  it('says nothing while the total itself is unreadable', () => {
    expect(arithmeticHint({ ...base, total: 'abc' })).toBeUndefined();
  });

  it('linesSum is undefined when any line has no amount', () => {
    expect(linesSum([{ ...EMPTY_LINE, amount: '1' }, { ...EMPTY_LINE }])).toBeUndefined();
    expect(linesSum([{ ...EMPTY_LINE, amount: '1' }, { ...EMPTY_LINE, amount: '2.50' }])).toBe('350');
  });
});
