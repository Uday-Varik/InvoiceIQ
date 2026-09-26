import { describe, expect, it } from 'vitest';
import * as contract from '@invoiceiq/contracts/core-api/zod';
import { HttpProblem } from '../src/http/problem.js';
import { CORRECTABLE_FIELDS, EDITABLE_STATES, cleanLines, normalizeQuantity, planCorrection, type CorrectionInput } from '../src/invoices/corrections.js';
import { CSV_COLUMNS, csvQuote, csvRow, csvText, exportFilename, formatMinor, toCsv } from '../src/invoices/export.js';
import { filterSql, isCalendarDate, likePattern, parseFilter } from '../src/invoices/filters.js';
import { checkTotals, headerFrom, linesFrom } from '../src/invoices/pipeline.js';
import { headerOf, type ExtractedHeader, type InvoiceRow, type LineItemInput, type LineItemRow } from '../src/invoices/store.js';
import { toInvoice, toLineItem } from '../src/invoices/view.js';
import { INVOICE_STATES, type InvoiceState } from '../src/domain/index.js';
import type { ExtractionResult } from '../src/clients/ai-service.js';

const ID = '0b6f5b1e-3c2d-4e5f-8a9b-0c1d2e3f4a5b';
const TENANT = '5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f';

function row(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: ID,
    tenant_id: TENANT,
    state: 'PENDING_APPROVAL',
    reasons: [],
    version: 9,
    source_channel: 'upload',
    document_sha256: 'a'.repeat(64),
    document_filename: 'acme.pdf',
    document_content_type: 'application/pdf',
    document_size_bytes: 1234,
    vendor_name: 'ACME',
    invoice_number: 'INV-1',
    invoice_date: '2026-03-14',
    currency: 'USD',
    total_minor: '123450',
    due_date: null,
    subtotal_minor: null,
    tax_minor: null,
    corrected_fields: [],
    vendor_id: null,
    payment_run_id: null,
    extraction: null,
    created_by: 'u',
    created_at: new Date('2026-03-14T10:00:00.000Z'),
    updated_at: new Date('2026-03-14T10:05:00.000Z'),
    cursor_ts: '2026-03-14T10:00:00.000000+00:00',
    ...over,
  };
}

function problemOf(fn: () => unknown): HttpProblem {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpProblem) return err;
    throw err;
  }
  throw new Error('expected an HttpProblem');
}

describe('filters: parseFilter', () => {
  it('an empty query is no filter', () => {
    expect(parseFilter({})).toEqual({});
  });

  it('keeps every valid filter, with totals as bigint', () => {
    expect(
      parseFilter({ state: 'HOLD', q: ' acme ', currency: 'EUR', dateFrom: '2026-01-01', dateTo: '2026-12-31', minTotalMinor: '-5', maxTotalMinor: '900' }),
    ).toEqual({ state: 'HOLD', q: 'acme', currency: 'EUR', dateFrom: '2026-01-01', dateTo: '2026-12-31', minTotalMinor: -5n, maxTotalMinor: 900n });
  });

  it('a blank search is dropped rather than matching everything by accident', () => {
    expect(parseFilter({ q: '   ' })).toEqual({});
  });

  it('equal bounds are allowed (a single day, an exact amount)', () => {
    expect(parseFilter({ dateFrom: '2026-02-28', dateTo: '2026-02-28', minTotalMinor: '7', maxTotalMinor: '7' })).toMatchObject({ minTotalMinor: 7n });
  });

  it.each([
    [{ state: 'LOST' }, 'lifecycle state'],
    [{ currency: 'usd' }, 'ISO 4217'],
    [{ currency: 'EURO' }, 'ISO 4217'],
    [{ dateFrom: '2026-02-29' }, 'real date'],
    [{ dateTo: '2026-13-01' }, 'real date'],
    [{ dateFrom: '20260101' }, 'real date'],
    [{ minTotalMinor: '1.00' }, 'minor units'],
    [{ maxTotalMinor: '1e9' }, 'minor units'],
    [{ maxTotalMinor: '9'.repeat(19) }, 'minor units'],
    [{ dateFrom: '2026-02-01', dateTo: '2026-01-31' }, 'after dateTo'],
    [{ minTotalMinor: '2', maxTotalMinor: '1' }, 'above maxTotalMinor'],
    [{ q: 'x'.repeat(101) }, '100 characters'],
  ])('%j is a 400 mentioning %s', (raw, text) => {
    const p = problemOf(() => parseFilter(raw));
    expect([p.status, p.code]).toEqual([400, 'INVALID_FILTER']);
    expect(p.detail).toContain(text);
  });
});

describe('filters: isCalendarDate', () => {
  it.each(['2026-01-01', '2024-02-29', '2026-12-31', '1999-06-15'])('%s is a date', (d) => expect(isCalendarDate(d)).toBe(true));
  it.each(['2026-02-29', '2026-04-31', '2026-00-10', '2026-1-1', '26-01-01', '2026-01-01T00:00:00Z', ''])('%s is not', (d) =>
    expect(isCalendarDate(d)).toBe(false),
  );
});

describe('filters: likePattern', () => {
  it.each([
    ['acme', '%acme%'],
    ['50%', '%50\\%%'],
    ['a_b', '%a\\_b%'],
    ['back\\slash', '%back\\\\slash%'],
  ])('%s -> %s', (q, expected) => expect(likePattern(q)).toBe(expected));
});

describe('filters: filterSql', () => {
  it('no filter is no WHERE fragment and no params', () => {
    const params: unknown[] = [];
    expect(filterSql({}, params)).toEqual([]);
    expect(params).toEqual([]);
  });

  it('builds placeholders only, never values, in a stable order', () => {
    const params: unknown[] = ['already-there'];
    const where = filterSql(
      { state: 'HOLD', q: "o'brien", currency: 'USD', dateFrom: '2026-01-01', dateTo: '2026-02-01', minTotalMinor: 1n, maxTotalMinor: 2n },
      params,
    );
    expect(where).toEqual([
      'i.state = $2',
      '(i.vendor_name ILIKE $3 OR i.invoice_number ILIKE $3 OR i.document_filename ILIKE $3)',
      'i.currency = $4',
      'i.invoice_date >= $5::date',
      'i.invoice_date <= $6::date',
      'i.total_minor >= $7::bigint',
      'i.total_minor <= $8::bigint',
    ]);
    expect(params).toEqual(['already-there', 'HOLD', "%o'brien%", 'USD', '2026-01-01', '2026-02-01', '1', '2']);
    expect(where.join(' ')).not.toContain("o'brien");
  });
});

describe('export: csvText and csvQuote', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=1+1', "'=1+1"],
    ['+SUM(A1)', "'+SUM(A1)"],
    ['-2+3', "'-2+3"],
    ['@cmd', "'@cmd"],
    ['\tTAB', "'\tTAB"],
    ['=HYPERLINK("x","y")', `"'=HYPERLINK(""x"",""y"")"`],
    ['ACME=Best', 'ACME=Best'],
  ])('%j -> %j', (input, expected) => expect(csvText(input)).toBe(expected));

  it('null, undefined and empty are an empty cell', () => {
    expect([csvText(null), csvText(undefined), csvText('')]).toEqual(['', '', '']);
  });

  it('csvQuote leaves safe values alone', () => {
    expect(csvQuote('INV-1')).toBe('INV-1');
  });
});

describe('export: formatMinor', () => {
  it.each([
    ['0', '0.00'],
    ['5', '0.05'],
    ['99', '0.99'],
    ['100', '1.00'],
    ['123450', '1234.50'],
    ['-1', '-0.01'],
    ['-123450', '-1234.50'],
    ['922337203685477580', '9223372036854775.80'],
  ])('%s -> %s', (minor, expected) => expect(formatMinor(minor, 'USD')).toBe(expected));

  it('null is an empty cell', () => expect(formatMinor(null, 'USD')).toBe(''));
  it('refuses a non-integer', () => expect(() => formatMinor('1.5', 'USD')).toThrow(RangeError));
});

describe('export: rows and files', () => {
  it('a row has one cell per column, money both formatted and exact', () => {
    const cells = csvRow(row({ subtotal_minor: '100000', tax_minor: '23450', due_date: '2026-04-13', reasons: [] }), 2).split(',');
    expect(cells).toHaveLength(CSV_COLUMNS.length);
    const byCol = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(byCol).toMatchObject({ subtotal: '1000.00', tax: '234.50', total: '1234.50', total_minor: '123450', line_items: '2', due_date: '2026-04-13' });
  });

  it('multi-valued cells are ;-joined', () => {
    const r = row({ state: 'EXCEPTION', reasons: ['VALIDATION_MISSING_FIELD', 'VALIDATION_TOTALS_MISMATCH'], corrected_fields: ['tax', 'total'] });
    const cells = csvRow(r, 0).split(',');
    expect(cells[CSV_COLUMNS.indexOf('reasons')]).toBe('VALIDATION_MISSING_FIELD;VALIDATION_TOTALS_MISMATCH');
    expect(cells[CSV_COLUMNS.indexOf('corrected_fields')]).toBe('tax;total');
  });

  it('missing values are empty cells, not "null"', () => {
    const r = row({ vendor_name: null, invoice_number: null, invoice_date: null, currency: null, total_minor: null });
    expect(csvRow(r, 0)).not.toContain('null');
  });

  it('a negative total (credit note) keeps its sign', () => {
    const cells = csvRow(row({ total_minor: '-5000' }), 0).split(',');
    expect(cells[CSV_COLUMNS.indexOf('total')]).toBe('-50.00');
  });

  it('toCsv starts with a BOM and the header and ends every line with CRLF', () => {
    const csv = toCsv([row(), row({ id: 'b'.repeat(8) })], new Map([[ID, 3]]));
    expect(csv.startsWith(`\uFEFF${CSV_COLUMNS.join(',')}\r\n`)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(4);
  });

  it('an empty export is just the header', () => {
    expect(toCsv([])).toBe(`\uFEFF${CSV_COLUMNS.join(',')}\r\n`);
  });

  it('file names carry the UTC day and the format', () => {
    expect(exportFilename('csv', new Date('2026-09-25T23:59:59Z'))).toBe('invoices-2026-09-25.csv');
    expect(exportFilename('json', new Date('2026-01-01T00:00:00Z'))).toBe('invoices-2026-01-01.json');
  });
});

describe('corrections: planCorrection', () => {
  const lines: LineItemRow[] = [{ invoice_id: ID, position: 1, description: 'Bolts', quantity: '2', unit_price_minor: '50', amount_minor: '100' }];
  const plan = (input: Omit<CorrectionInput, 'expectedVersion'>, r: InvoiceRow = row(), current: LineItemRow[] = lines) =>
    planCorrection(r, current, { expectedVersion: r.version, ...input });

  it('only states waiting on a reviewer are editable', () => {
    expect([...EDITABLE_STATES].sort()).toEqual(['EXCEPTION', 'HOLD', 'PENDING_APPROVAL']);
  });

  it.each(INVOICE_STATES.filter((s) => !['PENDING_APPROVAL', 'HOLD', 'EXCEPTION'].includes(s)))('%s is not editable (409 NOT_EDITABLE)', (state) => {
    const p = problemOf(() => plan({ vendorName: 'X' }, row({ state: state as InvoiceState })));
    expect([p.status, p.code]).toEqual([409, 'NOT_EDITABLE']);
  });

  it('a stale version is a 409 VERSION_CONFLICT naming both versions', () => {
    const p = problemOf(() => planCorrection(row(), lines, { expectedVersion: 8, vendorName: 'X' }));
    expect([p.status, p.code]).toEqual([409, 'VERSION_CONFLICT']);
    expect(p.detail).toContain('version 9, not 8');
  });

  it('maps each field to its column and records from/to', () => {
    const out = plan({
      vendorName: 'ACME Inc',
      invoiceNumber: 'INV-2',
      invoiceDate: '2026-03-15',
      dueDate: '2026-04-15',
      currency: 'EUR',
      totalMinor: '5',
      subtotalMinor: '4',
      taxMinor: '1',
    });
    expect(out.update).toEqual({
      vendor_name: 'ACME Inc',
      invoice_number: 'INV-2',
      invoice_date: '2026-03-15',
      due_date: '2026-04-15',
      currency: 'EUR',
      total_minor: '5',
      subtotal_minor: '4',
      tax_minor: '1',
    });
    expect(out.changes).toEqual({
      vendorName: { from: 'ACME', to: 'ACME Inc' },
      invoiceNumber: { from: 'INV-1', to: 'INV-2' },
      invoiceDate: { from: '2026-03-14', to: '2026-03-15' },
      dueDate: { from: null, to: '2026-04-15' },
      currency: { from: 'USD', to: 'EUR' },
      total: { from: '123450', to: '5' },
      subtotal: { from: null, to: '4' },
      tax: { from: null, to: '1' },
    });
    expect(out.lines).toBeUndefined();
  });

  it('unchanged fields are left out of both the update and the audit', () => {
    const out = plan({ vendorName: 'ACME', invoiceNumber: 'INV-9' });
    expect(out.update).toEqual({ invoice_number: 'INV-9' });
    expect(Object.keys(out.changes)).toEqual(['invoiceNumber']);
  });

  it('text is trimmed before comparing, so whitespace alone is no change', () => {
    expect(problemOf(() => plan({ vendorName: '  ACME ' })).code).toBe('NO_CHANGES');
  });

  it('amounts are canonicalised: leading zeros and -0 are the same number', () => {
    expect(problemOf(() => plan({ totalMinor: '0123450' })).code).toBe('NO_CHANGES');
    expect(plan({ taxMinor: '-0' }).update).toEqual({ tax_minor: '0' });
  });

  it('null clears an optional field, and clearing an empty one is no change', () => {
    const r = row({ subtotal_minor: '1', tax_minor: null, due_date: '2026-05-01' });
    const out = plan({ subtotalMinor: null, taxMinor: null, dueDate: null }, r);
    expect(out.update).toEqual({ subtotal_minor: null, due_date: null });
  });

  it.each([
    [{ vendorName: '   ' }, 'blank'],
    [{ vendorName: 'a\u0000b' }, 'control'],
    [{ invoiceNumber: 'x'.repeat(65) }, '64'],
    [{ invoiceDate: '2026-02-30' }, 'real date'],
    [{ dueDate: '2026-02-30' }, 'real date'],
    [{ currency: 'usd' }, 'ISO 4217'],
    [{ totalMinor: '12.5' }, 'minor units'],
    [{ subtotalMinor: 'abc' }, 'minor units'],
  ])('%j is a 422 (%s)', (input, text) => {
    const p = problemOf(() => plan(input));
    expect(p.status).toBe(422);
    expect(p.detail).toContain(text);
  });

  it('a due date before the invoice date is refused, including against the stored date', () => {
    expect(problemOf(() => plan({ dueDate: '2026-03-13' })).code).toBe('DUE_BEFORE_INVOICE_DATE');
    expect(problemOf(() => plan({ invoiceDate: '2026-06-01' }, row({ due_date: '2026-05-01' }))).code).toBe('DUE_BEFORE_INVOICE_DATE');
    expect(plan({ dueDate: '2026-03-14' }).update).toEqual({ due_date: '2026-03-14' });
  });

  it('moving both dates together is judged on the new pair', () => {
    expect(plan({ invoiceDate: '2026-06-01', dueDate: '2026-07-01' }, row({ due_date: '2026-05-01' })).update).toMatchObject({
      invoice_date: '2026-06-01',
      due_date: '2026-07-01',
    });
  });

  it('with no invoice date, any due date is fine', () => {
    expect(plan({ dueDate: '2000-01-01' }, row({ invoice_date: null })).update).toEqual({ due_date: '2000-01-01' });
  });

  it('identical lines are no change; any difference replaces them all', () => {
    expect(problemOf(() => plan({ lineItems: [{ description: 'Bolts', quantity: '2.000', unitPriceMinor: '50', amountMinor: '100' }] })).code).toBe(
      'NO_CHANGES',
    );
    const out = plan({ lineItems: [{ description: 'Bolts', quantity: '3', unitPriceMinor: '50', amountMinor: '150' }] });
    expect(out.lines).toEqual([{ description: 'Bolts', quantity: '3', unitPriceMinor: '50', amountMinor: '150' }]);
    expect(out.changes.lineItems?.from).toEqual([{ description: 'Bolts', quantity: '2', unitPriceMinor: '50', amountMinor: '100' }]);
  });

  it('an empty list clears the lines', () => {
    expect(plan({ lineItems: [] }).lines).toEqual([]);
  });

  it('a body with only a comment changes nothing', () => {
    expect(problemOf(() => plan({ comment: 'looked at it' })).code).toBe('NO_CHANGES');
  });

  it('every correctable field has a contract name', () => {
    expect([...CORRECTABLE_FIELDS]).toEqual(contract.CorrectableField.options);
  });
});

describe('corrections: lines and quantities', () => {
  it.each([
    ['2', '2'],
    ['2.0', '2'],
    ['2.5000', '2.5'],
    ['002.50', '2.5'],
    ['0.0001', '0.0001'],
    ['0', '0'],
    ['000', '0'],
  ])('quantity %s -> %s', (q, expected) => expect(normalizeQuantity(q)).toBe(expected));

  it.each(['-1', '1e3', '1.23456', '1,000', ''])('quantity %j is refused', (q) => {
    expect(problemOf(() => normalizeQuantity(q)).status).toBe(422);
  });

  it('absent numbers are unknown, not zero', () => {
    expect(cleanLines([{ description: 'x' }])).toEqual([{ description: 'x', quantity: null, unitPriceMinor: null, amountMinor: null }]);
  });

  it('refuses more than 200 lines and blank descriptions', () => {
    expect(problemOf(() => cleanLines(Array.from({ length: 201 }, () => ({ description: 'x' })))).status).toBe(422);
    expect(problemOf(() => cleanLines([{ description: ' ' }])).detail).toContain('lineItems[0].description');
  });
});

describe('pipeline: checkTotals', () => {
  const header = (over: Partial<ExtractedHeader>): ExtractedHeader => ({
    vendorName: 'v',
    invoiceNumber: 'n',
    invoiceDate: null,
    currency: 'USD',
    totalMinor: 1200n,
    subtotalMinor: null,
    taxMinor: null,
    dueDate: null,
    ...over,
  });
  const l = (amount: string | null): LineItemInput => ({ description: 'x', quantity: null, unitPriceMinor: null, amountMinor: amount });

  it('nothing printed but the total: nothing to check', () => {
    expect(checkTotals(header({}), [])).toEqual([]);
  });

  it('no total: nothing to check', () => {
    expect(checkTotals(header({ totalMinor: null, subtotalMinor: 1n }), [l('5')])).toEqual([]);
  });

  it('subtotal + tax = total passes', () => {
    expect(checkTotals(header({ subtotalMinor: 1000n, taxMinor: 200n }), [])).toEqual([]);
  });

  it('subtotal with no tax must equal the total', () => {
    expect(checkTotals(header({ subtotalMinor: 1000n }), [])).toEqual([{ check: 'subtotal_plus_tax', expectedTotalMinor: '1000', totalMinor: '1200' }]);
  });

  it('is exact to the minor unit: one cent off fails', () => {
    expect(checkTotals(header({ subtotalMinor: 1000n, taxMinor: 199n }), [])).toHaveLength(1);
  });

  it('lines + tax = total passes', () => {
    expect(checkTotals(header({ taxMinor: 200n }), [l('600'), l('400')])).toEqual([]);
  });

  it('lines that miss are reported with the expected total', () => {
    expect(checkTotals(header({}), [l('600'), l('500')])).toEqual([{ check: 'lines_plus_tax', expectedTotalMinor: '1100', totalMinor: '1200' }]);
  });

  it('a line with no amount skips the line check', () => {
    expect(checkTotals(header({}), [l('600'), l(null)])).toEqual([]);
  });

  it('both checks can fail at once', () => {
    expect(checkTotals(header({ subtotalMinor: 1n, taxMinor: 1n }), [l('5')]).map((f) => f.check)).toEqual(['subtotal_plus_tax', 'lines_plus_tax']);
  });

  it('credit notes (negative amounts) add up the same way', () => {
    expect(checkTotals(header({ totalMinor: -1200n, subtotalMinor: -1000n, taxMinor: -200n }), [l('-1000')])).toEqual([]);
  });

  it('sums beyond 2^63 do not overflow (bigint)', () => {
    const big = 2n ** 62n;
    expect(checkTotals(header({ totalMinor: 1n }), [l(big.toString()), l(big.toString())])[0]?.expectedTotalMinor).toBe((2n ** 63n).toString());
  });
});

describe('pipeline: headerFrom and linesFrom (Phase 2 fields)', () => {
  const field = (value: string | null) => ({ value, confidence: 0.9 });
  const ex = (fields: Record<string, string | null> = {}, lineItems: ExtractionResult['lineItems'] = []): ExtractionResult => ({
    documentSha256: 'a'.repeat(64),
    provider: 'p',
    fields: {
      vendorName: field('ACME'),
      invoiceNumber: field('INV-1'),
      invoiceDate: field('2026-03-14'),
      currency: field('USD'),
      totalMinor: field('1200'),
      subtotalMinor: field(null),
      taxMinor: field(null),
      dueDate: field(null),
      ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, field(v)])),
    },
    lineItems,
  });

  it('keeps well-formed subtotal, tax and due date', () => {
    expect(headerFrom(ex({ subtotalMinor: '1000', taxMinor: '200', dueDate: '2026-04-13' }))).toMatchObject({
      subtotalMinor: 1000n,
      taxMinor: 200n,
      dueDate: '2026-04-13',
    });
  });

  it.each([
    ['subtotalMinor', '10.00'],
    ['taxMinor', '99999999999999999999'],
    ['dueDate', '13/04/2026'],
    ['dueDate', 'soon'],
  ])('drops a malformed %s (%s)', (k, v) => {
    expect((headerFrom(ex({ [k]: v })) as unknown as Record<string, unknown>)[k]).toBeNull();
  });

  const li = (over: Partial<ExtractionResult['lineItems'][number]>): ExtractionResult['lineItems'][number] => ({
    description: 'Bolts',
    quantity: '2',
    unitPriceMinor: '50',
    amountMinor: '100',
    confidence: 0.9,
    ...over,
  });

  it('carries lines as stored rows', () => {
    expect(linesFrom(ex({}, [li({})]))).toEqual([{ description: 'Bolts', quantity: '2', unitPriceMinor: '50', amountMinor: '100' }]);
  });

  it('trims descriptions and drops blank ones', () => {
    expect(linesFrom(ex({}, [li({ description: '  Nuts  ' }), li({ description: '   ' })])).map((l) => l.description)).toEqual(['Nuts']);
  });

  it('an out-of-range number is stored as unknown, the line kept', () => {
    expect(linesFrom(ex({}, [li({ amountMinor: '9999999999999999999' })]))[0]?.amountMinor).toBeNull();
  });

  it('never stores more than 200 lines', () => {
    expect(linesFrom(ex({}, Array.from({ length: 200 }, () => li({})))).length).toBe(200);
  });
});

describe('store: headerOf', () => {
  it('reads the row as the validator sees it, amounts as bigint', () => {
    expect(headerOf(row({ subtotal_minor: '100000', tax_minor: '23450', due_date: '2026-04-13' }))).toEqual({
      vendorName: 'ACME',
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-03-14',
      currency: 'USD',
      totalMinor: 123450n,
      subtotalMinor: 100000n,
      taxMinor: 23450n,
      dueDate: '2026-04-13',
    });
  });

  it('nulls stay null', () => {
    expect(headerOf(row({ total_minor: null, currency: null }))).toMatchObject({ totalMinor: null, currency: null });
  });
});

describe('view: toInvoice and toLineItem (Phase 2)', () => {
  it('money fields share the invoice currency and appear only when known', () => {
    const v = toInvoice(row({ subtotal_minor: '100000', tax_minor: '23450', due_date: '2026-04-13' }));
    expect(v).toMatchObject({
      dueDate: '2026-04-13',
      subtotal: { amountMinor: '100000', currency: 'USD' },
      tax: { amountMinor: '23450', currency: 'USD' },
    });
    const bare = toInvoice(row());
    expect(bare).not.toHaveProperty('subtotal');
    expect(bare).not.toHaveProperty('tax');
    expect(bare).not.toHaveProperty('dueDate');
  });

  it('with no currency, no money is shown at all', () => {
    const v = toInvoice(row({ currency: null, subtotal_minor: '1' }));
    expect(v).not.toHaveProperty('total');
    expect(v).not.toHaveProperty('subtotal');
  });

  it('corrections appear once something was corrected', () => {
    expect(toInvoice(row())).not.toHaveProperty('corrections');
    expect(toInvoice(row({ corrected_fields: ['tax', 'total'] })).corrections).toEqual(['tax', 'total']);
  });

  it('line items appear only when asked for', () => {
    expect(toInvoice(row())).not.toHaveProperty('lineItems');
    expect(toInvoice(row(), { lineItems: [] }).lineItems).toEqual([]);
  });

  it('a line omits unknown numbers rather than sending null', () => {
    expect(toLineItem({ invoice_id: ID, position: 3, description: 'x', quantity: null, unit_price_minor: null, amount_minor: '5' })).toEqual({
      position: 3,
      description: 'x',
      amountMinor: '5',
    });
  });

  it('a Phase 1 extraction (no lines stored) still renders, contract-valid', () => {
    const v = toInvoice(
      row({
        extraction: {
          documentSha256: 'a'.repeat(64),
          provider: 'heuristic',
          extractedAt: '2026-03-14T10:00:00.000Z',
          fields: {
            vendorName: { value: 'ACME', confidence: 0.95 },
            invoiceNumber: { value: 'INV-1', confidence: 0.95 },
            invoiceDate: { value: '2026-03-14', confidence: 0.95 },
            currency: { value: 'USD', confidence: 0.95 },
            totalMinor: { value: '123450', confidence: 0.95 },
          },
        } as unknown as InvoiceRow['extraction'],
      }),
    );
    expect(v.extraction).not.toHaveProperty('lineItems');
    expect(() => contract.Invoice.parse(v)).not.toThrow();
  });

  it('a full Phase 2 view is contract-valid', () => {
    const v = toInvoice(row({ subtotal_minor: '1', tax_minor: '2', due_date: '2026-04-01', corrected_fields: ['lineItems'] }), {
      lineItems: [{ invoice_id: ID, position: 1, description: 'x', quantity: '1.5', unit_price_minor: '2', amount_minor: '3' }],
      history: [],
    });
    expect(() => contract.Invoice.parse(v)).not.toThrow();
  });
});
