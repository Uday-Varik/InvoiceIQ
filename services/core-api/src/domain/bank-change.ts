/**
 * Vendor bank-detail-change quarantine. Any change to a vendor's remittance
 * account starts a quarantine; payments to that vendor are held until the
 * window has elapsed AND an out-of-band callback verification is recorded by a
 * human who did not make the change (four-eyes).
 */

export interface BankChange {
  readonly vendorId: string;
  readonly changedAt: string; // RFC 3339
  readonly changedBy: string;
  readonly verifiedBy?: string;
  readonly verifiedAt?: string;
}

export type QuarantineStatus =
  | { readonly quarantined: false }
  | { readonly quarantined: true; readonly releasesAt: string | null; readonly why: 'WINDOW_OPEN' | 'UNVERIFIED' | 'SELF_VERIFIED' };

export function quarantineStatus(change: BankChange | undefined, now: Date, quarantineHours: number): QuarantineStatus {
  if (change === undefined) return { quarantined: false };
  const windowEnd = new Date(Date.parse(change.changedAt) + quarantineHours * 3_600_000);
  if (change.verifiedBy !== undefined && change.verifiedBy === change.changedBy) {
    return { quarantined: true, releasesAt: null, why: 'SELF_VERIFIED' };
  }
  if (change.verifiedBy === undefined) {
    return { quarantined: true, releasesAt: null, why: 'UNVERIFIED' };
  }
  if (now < windowEnd) {
    return { quarantined: true, releasesAt: windowEnd.toISOString(), why: 'WINDOW_OPEN' };
  }
  return { quarantined: false };
}
