import { createHash, randomBytes } from 'node:crypto';

/**
 * Single-use account tokens (email verification, password reset) and the
 * password/lockout policy. Raw tokens are emailed or logged; only their
 * SHA-256 hash is stored, so a leaked table yields no usable token, and
 * every token expires and can be used at most once.
 */

export function newAccountToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashAccountToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenExpiry(hours: number, now: number = Date.now()): Date {
  return new Date(now + hours * 60 * 60 * 1000);
}

/** Verification links live a day; reset links live one hour. */
export const VERIFICATION_TOKEN_HOURS = 24;
export const RESET_TOKEN_HOURS = 1;

/** Passwords: at least 12 characters. No complexity theatre beyond length. */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordError(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return undefined;
}

/** Brute-force lockout: 5 bad passwords in a row locks the account 15 minutes. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export function isLocked(lockedUntil: Date | null, now: number = Date.now()): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now;
}

/** Seconds until a lock expires, for the client to show; 0 when not locked. */
export function lockRetryAfterSeconds(lockedUntil: Date | null, now: number = Date.now()): number {
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((lockedUntil.getTime() - now) / 1000));
}
