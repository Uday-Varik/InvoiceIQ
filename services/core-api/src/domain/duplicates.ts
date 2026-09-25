import type { Money } from './money.js';
import type { DeterministicReasonCode } from './reasons.js';

/**
 * Deterministic duplicate detection. Semantic (AI) duplicate detection lives in
 * ai-service and can only ever produce AI_SEMANTIC_DUPLICATE_SUSPECTED (a HOLD).
 */

export interface InvoiceFingerprint {
  readonly invoiceId: string;
  readonly vendorId: string;
  readonly invoiceNumber: string;
  readonly total: Money;
  readonly invoiceDate: string; // YYYY-MM-DD
}

/** Uppercase, strip everything but letters and digits, drop leading zeros of the numeric tail. */
export function normalizeInvoiceNumber(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.replace(/^([A-Z]*)0+(?=\d)/, '$1');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min((prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

export interface DuplicateHit {
  readonly existingInvoiceId: string;
  readonly reason: Extract<DeterministicReasonCode, 'DUPLICATE_EXACT' | 'DUPLICATE_NEAR'>;
}

export function findDuplicates(
  candidate: InvoiceFingerprint,
  existing: readonly InvoiceFingerprint[],
  opts: { readonly windowDays: number; readonly nearMatchMaxEditDistance: number },
): DuplicateHit[] {
  const num = normalizeInvoiceNumber(candidate.invoiceNumber);
  const hits: DuplicateHit[] = [];
  for (const e of existing) {
    if (e.invoiceId === candidate.invoiceId || e.vendorId !== candidate.vendorId) continue;
    const sameAmount = e.total.currency === candidate.total.currency && e.total.amountMinor === candidate.total.amountMinor;
    if (!sameAmount) continue;
    const eNum = normalizeInvoiceNumber(e.invoiceNumber);
    if (eNum === num) {
      hits.push({ existingInvoiceId: e.invoiceId, reason: 'DUPLICATE_EXACT' });
    } else if (
      daysBetween(e.invoiceDate, candidate.invoiceDate) <= opts.windowDays &&
      editDistance(eNum, num) <= opts.nearMatchMaxEditDistance
    ) {
      hits.push({ existingInvoiceId: e.invoiceId, reason: 'DUPLICATE_NEAR' });
    }
  }
  return hits;
}
