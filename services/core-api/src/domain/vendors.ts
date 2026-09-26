import { quarantineStatus, type BankChange, type QuarantineStatus } from './bank-change.js';

/**
 * Vendor master rules. Invoices are linked to a vendor by a normalised name;
 * a vendor can block payment by being inactive or by an open bank-change
 * quarantine (domain/bank-change.ts).
 */

export type VendorStatus = 'active' | 'inactive';

/**
 * The key two spellings of one vendor share: Unicode-normalised, lower-cased,
 * punctuation turned into spaces, whitespace collapsed. Legal suffixes are
 * kept on purpose: "Acme Ltd" and "Acme Inc" may be different payees.
 */
export function vendorMatchKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 256);
}

export type PaymentBlock =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly reason: 'VENDOR_INACTIVE' }
  | { readonly blocked: true; readonly reason: 'VENDOR_BANK_CHANGE_QUARANTINE'; readonly quarantine: Extract<QuarantineStatus, { quarantined: true }> };

/**
 * Whether money may go to this vendor now. Only the latest bank change
 * matters: an older verified change does not release a newer unverified one.
 */
export function paymentBlock(status: VendorStatus, latestChange: BankChange | undefined, now: Date, quarantineHours: number): PaymentBlock {
  if (status === 'inactive') return { blocked: true, reason: 'VENDOR_INACTIVE' };
  const q = quarantineStatus(latestChange, now, quarantineHours);
  if (q.quarantined) return { blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', quarantine: q };
  return { blocked: false };
}
