import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApproverRole } from './auth.js';

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

/**
 * MFA step-up tokens. After primary authentication, an identity with MFA
 * enabled gets this short-lived signed token (10 minutes) instead of a
 * session; the challenge endpoint exchanges it for a session once the
 * TOTP code or a recovery code checks out. The token carries no secret,
 * only the already-verified identity, and it is purpose-tagged so it can
 * never be mistaken for a session.
 */
export interface MfaPendingPayload {
  readonly uid: string;
  readonly provider: string;
  readonly login: string;
  readonly tid: string;
  readonly roles: readonly ApproverRole[];
  readonly exp: number;
}

export const MFA_PENDING_TTL_MS = 10 * 60 * 1000;
export const MFA_PENDING_COOKIE = 'iq_mfa_pending';

export function signMfaPending(payload: Omit<MfaPendingPayload, 'exp'>, secret: string): string {
  const full: MfaPendingPayload = { ...payload, exp: Date.now() + MFA_PENDING_TTL_MS };
  const data = Buffer.from(JSON.stringify({ ...full, purpose: 'mfa-pending' })).toString('base64url');
  const mac = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

export function verifyMfaPending(token: string, secret: string): MfaPendingPayload | undefined {
  const dot = token.indexOf('.');
  if (dot < 1) return undefined;
  const data = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as MfaPendingPayload & { purpose?: string };
    if (payload.purpose !== 'mfa-pending') return undefined;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return undefined;
    if (!payload.uid || !payload.provider || !payload.login || !payload.tid) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function mfaPendingSetCookie(token: string, secure: boolean): string {
  return `${MFA_PENDING_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=600`;
}

export function mfaPendingClearCookie(secure: boolean): string {
  return `${MFA_PENDING_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
