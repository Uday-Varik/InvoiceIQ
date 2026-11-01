import { describe, expect, it } from 'vitest';
import {
  hashAccountToken,
  isLocked,
  lockRetryAfterSeconds,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
  newAccountToken,
  passwordError,
  tokenExpiry,
} from '../src/auth/tokens.js';
import { logMailer, resetLink, verificationLink } from '../src/auth/mailer.js';

describe('account tokens', () => {
  it('tokens are unique and only their hash is stored', () => {
    const a = newAccountToken();
    const b = newAccountToken();
    expect(a).not.toBe(b);
    expect(hashAccountToken(a)).toBe(hashAccountToken(a));
    expect(hashAccountToken(a)).not.toBe(a);
    expect(hashAccountToken(a)).not.toBe(hashAccountToken(b));
  });

  it('expiry is a fixed offset from now', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    expect(tokenExpiry(24, now).toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(tokenExpiry(1, now).toISOString()).toBe('2026-11-01T11:00:00.000Z');
  });
});

describe('password policy', () => {
  it('requires at least 12 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordError('short')).toBeDefined();
    expect(passwordError('eleven-char')).toBeDefined();
    expect(passwordError('twelve-chars!')).toBeUndefined();
  });
});

describe('lockout', () => {
  it('locks after 5 failures for 15 minutes', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
    expect(LOCKOUT_MS).toBe(15 * 60 * 1000);
    const lockedUntil = new Date(Date.now() + LOCKOUT_MS);
    expect(isLocked(lockedUntil)).toBe(true);
    expect(lockRetryAfterSeconds(lockedUntil)).toBeGreaterThan(0);
    expect(isLocked(null)).toBe(false);
    expect(isLocked(new Date(Date.now() - 1000))).toBe(false);
    expect(lockRetryAfterSeconds(null)).toBe(0);
  });
});

describe('mailer links', () => {
  it('builds absolute links from the frontend origin', () => {
    expect(verificationLink('https://app.example.com/', 'tok')).toBe('https://app.example.com/login?verify=tok');
    expect(resetLink('https://app.example.com', 'tok')).toBe('https://app.example.com/reset-password?token=tok');
    expect(verificationLink(undefined, 'tok')).toBe('/login?verify=tok');
  });

  it('log mailer resolves without sending', async () => {
    const mailer = logMailer({ from: 'no-reply@invoiceiq.local' });
    await expect(mailer.sendVerificationEmail('a@example.com', 'https://x/login?verify=t')).resolves.toBeUndefined();
    await expect(mailer.sendPasswordResetEmail('a@example.com', 'https://x/reset-password?token=t')).resolves.toBeUndefined();
  });
});
