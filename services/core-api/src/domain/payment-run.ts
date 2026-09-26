import type { PaymentBlock } from './vendors.js';

/**
 * Payment-run assembly. Pure: given approved invoices and each vendor's
 * payment block, decide which invoices go into the run and which must be held
 * instead. Nothing is paid to a vendor that is inactive, quarantined or unknown.
 */

export interface PayableCandidate {
  readonly id: string;
  readonly currency: string | null;
  readonly totalMinor: bigint | null;
  readonly vendorId: string | null;
}

export type Exclusion =
  | { readonly id: string; readonly action: 'hold'; readonly reason: 'VENDOR_INACTIVE' | 'VENDOR_BANK_CHANGE_QUARANTINE' | 'VENDOR_UNKNOWN' }
  | { readonly id: string; readonly action: 'skip'; readonly why: 'CURRENCY_MISMATCH' | 'TOTAL_UNKNOWN' };

export interface RunPlan {
  readonly queue: readonly PayableCandidate[];
  readonly excluded: readonly Exclusion[];
  readonly totalMinor: bigint;
}

export function planPaymentRun(
  currency: string,
  candidates: readonly PayableCandidate[],
  blockFor: (vendorId: string) => PaymentBlock | undefined,
): RunPlan {
  const queue: PayableCandidate[] = [];
  const excluded: Exclusion[] = [];
  let total = 0n;
  for (const c of candidates) {
    if (c.currency !== currency) {
      excluded.push({ id: c.id, action: 'skip', why: 'CURRENCY_MISMATCH' });
      continue;
    }
    if (c.totalMinor === null || c.totalMinor < 0n) {
      excluded.push({ id: c.id, action: 'skip', why: 'TOTAL_UNKNOWN' });
      continue;
    }
    const block = c.vendorId === null ? undefined : blockFor(c.vendorId);
    if (block === undefined) {
      excluded.push({ id: c.id, action: 'hold', reason: 'VENDOR_UNKNOWN' });
      continue;
    }
    if (block.blocked) {
      excluded.push({ id: c.id, action: 'hold', reason: block.reason });
      continue;
    }
    queue.push(c);
    total += c.totalMinor;
  }
  return { queue, excluded, totalMinor: total };
}
