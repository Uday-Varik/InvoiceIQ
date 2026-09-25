import { describe, expect, it } from 'vitest';
import { money, threeWayMatch, type MatchInput } from '../src/domain/index.js';

function base(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    mode: 'three_way',
    priceToleranceBps: 100,
    quantityToleranceBps: 0,
    poFound: true,
    poLines: [
      { lineId: 'L1', unitPrice: money(10_000, 'USD'), orderedQtyMilli: 10_000n },
      { lineId: 'L2', unitPrice: money(2_500, 'USD'), orderedQtyMilli: 4_000n },
    ],
    receipts: [
      { poLineId: 'L1', receivedQtyMilli: 10_000n },
      { poLineId: 'L2', receivedQtyMilli: 4_000n },
    ],
    invoiceLines: [
      { poLineId: 'L1', unitPrice: money(10_000, 'USD'), qtyMilli: 10_000n },
      { poLineId: 'L2', unitPrice: money(2_500, 'USD'), qtyMilli: 4_000n },
    ],
    ...overrides,
  };
}

describe('three-way match', () => {
  it('matches a clean invoice', () => {
    expect(threeWayMatch(base())).toEqual({ matched: true, findings: [], reasons: [] });
  });

  it('flags a missing PO', () => {
    expect(threeWayMatch(base({ poFound: false })).reasons).toEqual(['MATCH_PO_NOT_FOUND']);
  });

  it('flags an invoice line for an unknown PO line', () => {
    const r = threeWayMatch(base({ invoiceLines: [{ poLineId: 'L9', unitPrice: money(1, 'USD'), qtyMilli: 1000n }] }));
    expect(r.reasons).toEqual(['MATCH_PO_NOT_FOUND']);
  });

  it('accepts price within tolerance (1%)', () => {
    const r = threeWayMatch(base({ invoiceLines: [{ poLineId: 'L1', unitPrice: money(10_100, 'USD'), qtyMilli: 10_000n }] }));
    expect(r.matched).toBe(true);
  });

  it('flags price just outside tolerance', () => {
    const r = threeWayMatch(base({ invoiceLines: [{ poLineId: 'L1', unitPrice: money(10_101, 'USD'), qtyMilli: 10_000n }] }));
    expect(r.reasons).toEqual(['MATCH_PRICE_VARIANCE']);
  });

  it('flags a currency mismatch as a price variance', () => {
    const r = threeWayMatch(base({ invoiceLines: [{ poLineId: 'L1', unitPrice: money(10_000, 'EUR'), qtyMilli: 10_000n }] }));
    expect(r.reasons).toEqual(['MATCH_PRICE_VARIANCE']);
  });

  it('flags over-billing against received quantity', () => {
    const r = threeWayMatch(base({ receipts: [{ poLineId: 'L1', receivedQtyMilli: 8_000n }, { poLineId: 'L2', receivedQtyMilli: 4_000n }] }));
    expect(r.reasons).toEqual(['MATCH_QUANTITY_VARIANCE']);
  });

  it('sums split invoice lines and partial receipts', () => {
    const r = threeWayMatch(
      base({
        receipts: [
          { poLineId: 'L1', receivedQtyMilli: 6_000n },
          { poLineId: 'L1', receivedQtyMilli: 4_000n },
        ],
        invoiceLines: [
          { poLineId: 'L1', unitPrice: money(10_000, 'USD'), qtyMilli: 5_000n },
          { poLineId: 'L1', unitPrice: money(10_000, 'USD'), qtyMilli: 5_000n },
        ],
      }),
    );
    expect(r.matched).toBe(true);
  });

  it('flags a missing receipt in three-way mode', () => {
    const r = threeWayMatch(base({ receipts: [{ poLineId: 'L1', receivedQtyMilli: 10_000n }] }));
    expect(r.reasons).toEqual(['MATCH_RECEIPT_MISSING']);
  });

  it('ignores receipts in two-way mode but checks ordered quantity', () => {
    expect(threeWayMatch(base({ mode: 'two_way', receipts: [] })).matched).toBe(true);
    const r = threeWayMatch(
      base({ mode: 'two_way', receipts: [], invoiceLines: [{ poLineId: 'L2', unitPrice: money(2_500, 'USD'), qtyMilli: 5_000n }] }),
    );
    expect(r.reasons).toEqual(['MATCH_QUANTITY_VARIANCE']);
  });

  it('honours quantity tolerance', () => {
    const lines = [{ poLineId: 'L1', unitPrice: money(10_000, 'USD'), qtyMilli: 10_100n }];
    expect(threeWayMatch(base({ invoiceLines: lines })).matched).toBe(false);
    expect(threeWayMatch(base({ invoiceLines: lines, quantityToleranceBps: 100 })).matched).toBe(true);
  });

  it('reports multiple distinct reasons sorted and deduplicated', () => {
    const r = threeWayMatch(
      base({
        receipts: [{ poLineId: 'L1', receivedQtyMilli: 1_000n }],
        invoiceLines: [
          { poLineId: 'L1', unitPrice: money(20_000, 'USD'), qtyMilli: 10_000n },
          { poLineId: 'L2', unitPrice: money(9_999, 'USD'), qtyMilli: 4_000n },
        ],
      }),
    );
    expect(r.reasons).toEqual(['MATCH_PRICE_VARIANCE', 'MATCH_QUANTITY_VARIANCE', 'MATCH_RECEIPT_MISSING']);
  });
});
