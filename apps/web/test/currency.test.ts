import { describe, expect, it } from 'vitest';
import catalog from '@invoiceiq/contracts/catalog/reason-codes.json' with { type: 'json' };
import type { Invoice } from '../lib/api';
import { arithmeticHint, buildCorrection, formFromInvoice } from '../lib/corrections';
import { filtersToQuery, EMPTY_FILTERS, validateFilters } from '../lib/filters';
import { formatMoney } from '../lib/format';
import { currencyExponent, minorToInput, parseMoneyInput } from '../lib/money';

describe('currency exponents come from the catalog', () => {
  it('uses 0 for yen, 3 for dinars and 2 otherwise', () => {
    expect([currencyExponent('JPY'), currencyExponent('KRW'), currencyExponent('BHD'), currencyExponent('USD')]).toEqual([0, 0, 3, 2]);
    expect(currencyExponent('jpy')).toBe(0);
    expect([currencyExponent(''), currencyExponent(null), currencyExponent(undefined), currencyExponent('XYZ')]).toEqual([2, 2, 2, 2]);
  });

  it('reads the table core-api exports', () => {
    expect(catalog.currencyExponents.default).toBe(2);
    expect(catalog.currencyExponents.JPY).toBe(0);
  });
});

describe('formatMoney per currency', () => {
  it.each([
    ['1200000', 'JPY', '1,200,000 JPY'],
    ['-500', 'KRW', '-500 KRW'],
    ['0', 'JPY', '0 JPY'],
    ['1234567', 'BHD', '1,234.567 BHD'],
    ['5', 'KWD', '0.005 KWD'],
    ['123450', 'USD', '1,234.50 USD'],
  ])('%s %s -> %s', (minor, cur, out) => expect(formatMoney(minor, cur)).toBe(out));
});

describe('parseMoneyInput per currency', () => {
  it.each([
    ['12,000', 'JPY', '12000'],
    ['12000', 'JPY', '12000'],
    ['-5', 'JPY', '-5'],
    ['12.5', 'JPY', null],
    ['12.', 'JPY', null],
    ['1.5', 'BHD', '1500'],
    ['1.234', 'BHD', '1234'],
    ['1.2345', 'BHD', null],
    ['1.2345', 'CLF', '12345'],
    ['1.234', 'USD', null],
  ])('%j %s -> %j', (raw, cur, minor) => {
    const r = parseMoneyInput(raw, cur);
    expect(r.ok ? r.minor : null).toBe(minor);
  });

  it('explains the rule for the currency', () => {
    const yen = parseMoneyInput('1.5', 'JPY');
    const dinar = parseMoneyInput('1.2345', 'BHD');
    expect(!yen.ok && yen.error).toMatch(/whole numbers/);
    expect(!dinar.ok && dinar.error).toMatch(/3 decimals/);
  });

  it.each([
    ['12000', 'JPY', '12000'],
    ['1500', 'BHD', '1.500'],
    ['7', 'KWD', '0.007'],
    ['-7', 'KWD', '-0.007'],
  ])('minorToInput(%s, %s) -> %s and back', (minor, cur, input) => {
    expect(minorToInput(minor, cur)).toBe(input);
    const r = parseMoneyInput(input, cur);
    expect(r.ok && r.minor).toBe(minor);
  });
});

const YEN_INVOICE: Invoice = {
  id: '0b7c3c1e-7e3d-4f3a-9d8e-2a6f7e1b9c01',
  tenantId: '5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f',
  state: 'PENDING_APPROVAL',
  reasons: [],
  version: 3,
  vendorName: 'Tanaka Shoji',
  invoiceNumber: 'T-9',
  invoiceDate: '2026-03-14',
  total: { amountMinor: '110000', currency: 'JPY' },
  subtotal: { amountMinor: '100000', currency: 'JPY' },
  tax: { amountMinor: '10000', currency: 'JPY' },
  lineItems: [{ position: 1, description: 'Bolts', quantity: '100', unitPriceMinor: '1000', amountMinor: '100000' }],
  createdAt: '2026-03-14T10:00:00.000Z',
  updatedAt: '2026-03-14T10:00:00.000Z',
};

describe('correcting a yen invoice', () => {
  it('pre-fills whole yen', () => {
    const f = formFromInvoice(YEN_INVOICE);
    expect([f.total, f.subtotal, f.tax, f.lines[0]?.unitPrice, f.lines[0]?.amount]).toEqual(['110000', '100000', '10000', '1000', '100000']);
  });

  it('an untouched form changes nothing', () => {
    const r = buildCorrection(YEN_INVOICE, formFromInvoice(YEN_INVOICE));
    expect(r.ok && r.changed).toEqual([]);
  });

  it('sends a corrected total in yen, and refuses decimals', () => {
    const ok = buildCorrection(YEN_INVOICE, { ...formFromInvoice(YEN_INVOICE), total: '110,500', subtotal: '100,500' });
    expect(ok.ok && ok.body).toMatchObject({ totalMinor: '110500', subtotalMinor: '100500' });
    const bad = buildCorrection(YEN_INVOICE, { ...formFromInvoice(YEN_INVOICE), total: '1100.00' });
    expect(!bad.ok && bad.errors.total).toMatch(/whole numbers/);
  });

  it('reads amounts in the currency typed in the form', () => {
    const r = buildCorrection(YEN_INVOICE, { ...formFromInvoice(YEN_INVOICE), currency: 'BHD', total: '1.100', subtotal: '1.000', tax: '0.100', lines: [] });
    expect(r.ok && r.body).toMatchObject({ currency: 'BHD', totalMinor: '1100', subtotalMinor: '1000', taxMinor: '100' });
  });

  it('hints in yen when the numbers do not add up', () => {
    expect(arithmeticHint({ ...formFromInvoice(YEN_INVOICE), total: '120000' })).toBe('Subtotal + tax is 110000, not 120000');
  });
});

describe('dashboard filters in the chosen currency', () => {
  it('reads the amount bounds in yen when JPY is chosen', () => {
    const q = new URLSearchParams(filtersToQuery({ ...EMPTY_FILTERS, currency: 'JPY', minTotal: '10,000' }));
    expect(q.get('minTotalMinor')).toBe('10000');
  });

  it('refuses decimals for yen', () => {
    expect(validateFilters({ ...EMPTY_FILTERS, currency: 'JPY', minTotal: '10.5' }).minTotal).toMatch(/whole numbers/);
  });

  it('keeps two decimals when no currency is chosen', () => {
    expect(new URLSearchParams(filtersToQuery({ ...EMPTY_FILTERS, minTotal: '10' })).get('minTotalMinor')).toBe('1000');
  });
});
