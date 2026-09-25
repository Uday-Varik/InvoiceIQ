import { type Money, withinBasisPoints } from './money.js';
import type { DeterministicReasonCode } from './reasons.js';

/**
 * Deterministic 2-/3-way match at line level. Quantities are in thousandths
 * (1.5 units = 1500) so everything stays integer.
 */

export interface PoLine {
  readonly lineId: string;
  readonly unitPrice: Money;
  readonly orderedQtyMilli: bigint;
}

export interface ReceiptLine {
  readonly poLineId: string;
  readonly receivedQtyMilli: bigint;
}

export interface InvoiceLine {
  readonly poLineId: string;
  readonly unitPrice: Money;
  readonly qtyMilli: bigint;
}

export interface MatchInput {
  readonly mode: 'two_way' | 'three_way';
  readonly priceToleranceBps: number;
  readonly quantityToleranceBps: number;
  readonly poFound: boolean;
  readonly poLines: readonly PoLine[];
  readonly receipts: readonly ReceiptLine[];
  readonly invoiceLines: readonly InvoiceLine[];
}

export interface LineFinding {
  readonly poLineId: string;
  readonly reason: DeterministicReasonCode;
  readonly detail: string;
}

export interface MatchResult {
  readonly matched: boolean;
  readonly findings: readonly LineFinding[];
  readonly reasons: readonly DeterministicReasonCode[];
}

function withinQtyTolerance(actual: bigint, allowed: bigint, bps: number): boolean {
  if (actual <= allowed) return true;
  return (actual - allowed) * 10_000n <= allowed * BigInt(bps);
}

export function threeWayMatch(input: MatchInput): MatchResult {
  const findings: LineFinding[] = [];
  if (!input.poFound) {
    findings.push({ poLineId: '*', reason: 'MATCH_PO_NOT_FOUND', detail: 'purchase order not found' });
    return { matched: false, findings, reasons: ['MATCH_PO_NOT_FOUND'] };
  }

  const poById = new Map(input.poLines.map((l) => [l.lineId, l]));
  const received = new Map<string, bigint>();
  for (const r of input.receipts) {
    received.set(r.poLineId, (received.get(r.poLineId) ?? 0n) + r.receivedQtyMilli);
  }
  const invoiced = new Map<string, bigint>();

  for (const line of input.invoiceLines) {
    const po = poById.get(line.poLineId);
    if (po === undefined) {
      findings.push({ poLineId: line.poLineId, reason: 'MATCH_PO_NOT_FOUND', detail: 'invoice line references unknown PO line' });
      continue;
    }
    if (
      line.unitPrice.currency !== po.unitPrice.currency ||
      !withinBasisPoints(line.unitPrice, po.unitPrice, input.priceToleranceBps)
    ) {
      findings.push({ poLineId: line.poLineId, reason: 'MATCH_PRICE_VARIANCE', detail: 'unit price outside tolerance' });
    }
    invoiced.set(line.poLineId, (invoiced.get(line.poLineId) ?? 0n) + line.qtyMilli);
  }

  for (const [poLineId, qty] of invoiced) {
    const po = poById.get(poLineId);
    if (po === undefined) continue;
    if (input.mode === 'three_way') {
      const rec = received.get(poLineId);
      if (rec === undefined || rec === 0n) {
        findings.push({ poLineId, reason: 'MATCH_RECEIPT_MISSING', detail: 'no goods receipt for line' });
        continue;
      }
      if (!withinQtyTolerance(qty, rec, input.quantityToleranceBps)) {
        findings.push({ poLineId, reason: 'MATCH_QUANTITY_VARIANCE', detail: 'invoiced quantity exceeds received quantity' });
      }
    } else if (!withinQtyTolerance(qty, po.orderedQtyMilli, input.quantityToleranceBps)) {
      findings.push({ poLineId, reason: 'MATCH_QUANTITY_VARIANCE', detail: 'invoiced quantity exceeds ordered quantity' });
    }
  }

  const reasons = [...new Set(findings.map((f) => f.reason))].sort();
  return { matched: findings.length === 0, findings, reasons };
}
