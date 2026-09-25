import { describe, expect, it } from 'vitest';
import { editDistance, findDuplicates, money, normalizeInvoiceNumber, type InvoiceFingerprint } from '../src/domain/index.js';

const opts = { windowDays: 90, nearMatchMaxEditDistance: 1 };

function inv(id: string, over: Partial<InvoiceFingerprint> = {}): InvoiceFingerprint {
  return { invoiceId: id, vendorId: 'v1', invoiceNumber: 'INV-1001', total: money(125_000, 'USD'), invoiceDate: '2026-03-01', ...over };
}

describe('normalizeInvoiceNumber', () => {
  it.each([
    ['inv-1001', 'INV1001'],
    ['INV 1001', 'INV1001'],
    ['INV-0001001', 'INV1001'],
    ['#001001', '1001'],
    ['0000', '0'],
    ['A/B.12', 'AB12'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeInvoiceNumber(raw)).toBe(expected);
  });
});

describe('editDistance', () => {
  it.each([
    ['', '', 0],
    ['abc', 'abc', 0],
    ['abc', 'abd', 1],
    ['abc', 'ab', 1],
    ['kitten', 'sitting', 3],
    ['', 'abc', 3],
  ])('%j vs %j = %i', (a, b, d) => {
    expect(editDistance(a, b)).toBe(d);
  });
});

describe('findDuplicates', () => {
  it('finds an exact duplicate despite formatting differences', () => {
    const hits = findDuplicates(inv('new', { invoiceNumber: 'inv 1001' }), [inv('old')], opts);
    expect(hits).toEqual([{ existingInvoiceId: 'old', reason: 'DUPLICATE_EXACT' }]);
  });

  it('exact duplicates are flagged regardless of the window', () => {
    const hits = findDuplicates(inv('new', { invoiceDate: '2029-01-01' }), [inv('old')], opts);
    expect(hits[0]?.reason).toBe('DUPLICATE_EXACT');
  });

  it('finds a near duplicate inside the window', () => {
    const hits = findDuplicates(inv('new', { invoiceNumber: 'INV-1002', invoiceDate: '2026-03-15' }), [inv('old')], opts);
    expect(hits).toEqual([{ existingInvoiceId: 'old', reason: 'DUPLICATE_NEAR' }]);
  });

  it('ignores near duplicates outside the window', () => {
    expect(findDuplicates(inv('new', { invoiceNumber: 'INV-1002', invoiceDate: '2026-09-01' }), [inv('old')], opts)).toEqual([]);
  });

  it('ignores other vendors, other amounts and itself', () => {
    expect(findDuplicates(inv('new', { vendorId: 'v2' }), [inv('old')], opts)).toEqual([]);
    expect(findDuplicates(inv('new', { total: money(125_001, 'USD') }), [inv('old')], opts)).toEqual([]);
    expect(findDuplicates(inv('new', { total: money(125_000, 'EUR') }), [inv('old')], opts)).toEqual([]);
    expect(findDuplicates(inv('same'), [inv('same')], opts)).toEqual([]);
  });

  it('respects the edit distance limit', () => {
    const cand = inv('new', { invoiceNumber: 'INV-1099' });
    expect(findDuplicates(cand, [inv('old')], opts)).toEqual([]);
    expect(findDuplicates(cand, [inv('old')], { ...opts, nearMatchMaxEditDistance: 2 })).toHaveLength(1);
  });
});
