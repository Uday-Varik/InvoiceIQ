import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, otpauthUrl, totpCode, verifyTotp } from '../src/auth/totp.js';
import {
  consumeRecoveryCode,
  decryptTotpSecret,
  deriveMfaKey,
  disableMfa,
  enableMfa,
  encryptTotpSecret,
  getMfa,
  isMfaEnabled,
  newTotpSecret,
  storePendingMfa,
  type MfaDb,
} from '../src/auth/mfa.js';
import { signMfaPending, verifyMfaPending } from '../src/auth/tokens.js';

/** Base32 for the ASCII secret "12345678901234567890" (RFC 6238 test secret). */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SECRET = 'test-session-secret-that-is-long-enough-32chars';

describe('TOTP (RFC 6238 vectors, 6 digits)', () => {
  it('matches the published test vectors', () => {
    expect(totpCode(RFC_SECRET, 59_000)).toBe('287082');
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totpCode(RFC_SECRET, 1_111_111_111_000)).toBe('050471');
    expect(totpCode(RFC_SECRET, 1_234_567_890_000)).toBe('005924');
    expect(totpCode(RFC_SECRET, 2_000_000_000_000)).toBe('279037');
  });

  it('accepts one step either side of a boundary', () => {
    const code = totpCode(RFC_SECRET, 0);
    expect(verifyTotp(RFC_SECRET, code, 0)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, 29_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, 31_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, 61_000)).toBe(false);
  });

  it('rejects wrong and malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '000000', 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef', 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '28708', 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '2870822', 59_000)).toBe(false);
  });

  it('base32 round-trips', () => {
    const bytes = Buffer.from('hello-mfa-secret');
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
  });

  it('builds a standard otpauth URL', () => {
    const url = otpauthUrl('InvoiceIQ', 'user@example.com', RFC_SECRET);
    expect(url.startsWith('otpauth://totp/')).toBe(true);
    expect(url).toContain(`secret=${RFC_SECRET}`);
    expect(url).toContain('issuer=InvoiceIQ');
  });
});

describe('TOTP secret encryption', () => {
  it('round-trips and rejects tampering', () => {
    const key = deriveMfaKey(SECRET);
    const enc = encryptTotpSecret(RFC_SECRET, key);
    expect(decryptTotpSecret(enc.ciphertext, enc.iv, enc.tag, key)).toBe(RFC_SECRET);
    expect(() => decryptTotpSecret(enc.ciphertext, enc.iv, 'AAAAAAAAAAAAAAAAAAAAAA', key)).toThrow();
    expect(() => decryptTotpSecret(enc.ciphertext, enc.iv, enc.tag, deriveMfaKey('other-secret'))).toThrow();
    expect(newTotpSecret().length).toBe(32);
  });
});

describe('MFA pending tokens', () => {
  const payload = { uid: 'u1', provider: 'credentials', login: 'a@example.com', tid: 't1', roles: ['cfo'] as const };

  it('verifies a fresh token and rejects tampering', () => {
    const token = signMfaPending(payload, SECRET);
    expect(verifyMfaPending(token, SECRET)).toMatchObject({ uid: 'u1', login: 'a@example.com' });
    expect(verifyMfaPending(`${token}x`, SECRET)).toBeUndefined();
    expect(verifyMfaPending(token, 'other-secret-that-is-long-enough-32')).toBeUndefined();
  });

  it('rejects expired and wrong-purpose tokens', () => {
    const expired = (() => {
      const data = Buffer.from(
        JSON.stringify({ ...payload, roles: [...payload.roles], exp: Date.now() - 1000, purpose: 'mfa-pending' }),
      ).toString('base64url');
      return `${data}.${createHmac('sha256', SECRET).update(data).digest('base64url')}`;
    })();
    expect(verifyMfaPending(expired, SECRET)).toBeUndefined();
    const wrongPurpose = (() => {
      const data = Buffer.from(
        JSON.stringify({ ...payload, roles: [...payload.roles], exp: Date.now() + 600_000, purpose: 'session' }),
      ).toString('base64url');
      return `${data}.${createHmac('sha256', SECRET).update(data).digest('base64url')}`;
    })();
    expect(verifyMfaPending(wrongPurpose, SECRET)).toBeUndefined();
  });
});

/** In-memory stand-in for the user_mfa and recovery_codes tables. */
function fakeMfaDb(): MfaDb {
  const mfa = new Map<string, { provider: string; external_id: string; secret_ciphertext: string; secret_iv: string; secret_tag: string; enabled: boolean }>();
  const codes = new Map<string, { id: string; provider: string; external_id: string; code_hash: string; used_at: Date | null }>();
  let nextId = 1;
  const db = {
    query: (async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO user_mfa')) {
        const key = `${params[0]}:${params[1]}`;
        mfa.set(key, {
          provider: params[0] as string,
          external_id: params[1] as string,
          secret_ciphertext: params[2] as string,
          secret_iv: params[3] as string,
          secret_tag: params[4] as string,
          enabled: false,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM user_mfa')) {
        const row = mfa.get(`${params[0]}:${params[1]}`);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('UPDATE user_mfa SET enabled')) {
        const row = mfa.get(`${params[0]}:${params[1]}`);
        if (row) row.enabled = true;
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM user_mfa')) {
        return { rows: [], rowCount: mfa.delete(`${params[0]}:${params[1]}`) ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO recovery_codes')) {
        const id = String(nextId++);
        codes.set(id, {
          id,
          provider: params[0] as string,
          external_id: params[1] as string,
          code_hash: params[2] as string,
          used_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM recovery_codes')) {
        const found = [...codes.values()].find(
          (c) => c.provider === params[0] && c.external_id === params[1] && c.code_hash === params[2] && !c.used_at,
        );
        return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes('UPDATE recovery_codes SET used_at')) {
        const found = codes.get(params[0] as string);
        if (found && !found.used_at) found.used_at = new Date();
        return { rows: [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM recovery_codes')) {
        let n = 0;
        for (const [id, c] of codes) {
          if (c.provider === params[0] && c.external_id === params[1]) {
            codes.delete(id);
            n += 1;
          }
        }
        return { rows: [], rowCount: n };
      }
      return { rows: [], rowCount: 0 };
    }) as MfaDb['query'],
  };
  return db;
}

describe('MFA store', () => {
  it('setup stays disabled until verified, then enables with recovery codes', async () => {
    const db = fakeMfaDb();
    const key = deriveMfaKey(SECRET);
    await storePendingMfa(db, 'credentials', 'u1', encryptTotpSecret(RFC_SECRET, key));
    expect(await isMfaEnabled(db, 'credentials', 'u1')).toBe(false);
    const record = await getMfa(db, 'credentials', 'u1');
    expect(record?.enabled).toBe(false);
    expect(decryptTotpSecret(record!.secretCiphertext, record!.secretIv, record!.secretTag, key)).toBe(RFC_SECRET);
    const codes = await enableMfa(db, 'credentials', 'u1');
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await isMfaEnabled(db, 'credentials', 'u1')).toBe(true);
  });

  it('recovery codes are single-use', async () => {
    const db = fakeMfaDb();
    const key = deriveMfaKey(SECRET);
    await storePendingMfa(db, 'credentials', 'u1', encryptTotpSecret(RFC_SECRET, key));
    const codes = await enableMfa(db, 'credentials', 'u1');
    expect(await consumeRecoveryCode(db, 'credentials', 'u1', codes[0]!)).toBe(true);
    expect(await consumeRecoveryCode(db, 'credentials', 'u1', codes[0]!)).toBe(false);
    expect(await consumeRecoveryCode(db, 'credentials', 'u1', 'XXXX-XXXX')).toBe(false);
  });

  it('disable removes the secret and the codes', async () => {
    const db = fakeMfaDb();
    const key = deriveMfaKey(SECRET);
    await storePendingMfa(db, 'credentials', 'u1', encryptTotpSecret(RFC_SECRET, key));
    const codes = await enableMfa(db, 'credentials', 'u1');
    await disableMfa(db, 'credentials', 'u1');
    expect(await getMfa(db, 'credentials', 'u1')).toBeUndefined();
    expect(await consumeRecoveryCode(db, 'credentials', 'u1', codes[0]!)).toBe(false);
  });
});
