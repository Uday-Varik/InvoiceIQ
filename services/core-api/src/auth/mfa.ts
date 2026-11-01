import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { base32Encode } from './totp.js';
import { hashAccountToken } from './tokens.js';

/**
 * MFA storage: TOTP secrets encrypted at rest, recovery codes hashed and
 * single-use. The encryption key is derived from MFA_SECRET_KEY when set,
 * else from SESSION_SECRET; rotating the encryption key without
 * re-encrypting secrets locks every MFA user out, so the runbook treats
 * that key as rotate-only-with-re-encryption.
 */

export type MfaDb = Pick<Pool, 'query'>;

export interface MfaRecord {
  readonly provider: string;
  readonly externalId: string;
  readonly secretCiphertext: string;
  readonly secretIv: string;
  readonly secretTag: string;
  readonly enabled: boolean;
}

export function deriveMfaKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptTotpSecret(plaintextBase32: string, key: Buffer): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBase32, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

export function decryptTotpSecret(
  ciphertext: string,
  iv: string,
  tag: string,
  key: Buffer,
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    const bytes = randomBytes(8);
    for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

interface MfaRow {
  provider: string;
  external_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_tag: string;
  enabled: boolean;
}

function toRecord(row: MfaRow): MfaRecord {
  return {
    provider: row.provider,
    externalId: row.external_id,
    secretCiphertext: row.secret_ciphertext,
    secretIv: row.secret_iv,
    secretTag: row.secret_tag,
    enabled: row.enabled,
  };
}

export async function getMfa(db: MfaDb, provider: string, externalId: string): Promise<MfaRecord | undefined> {
  const { rows } = await db.query<MfaRow>('SELECT * FROM user_mfa WHERE provider = $1 AND external_id = $2', [
    provider,
    externalId,
  ]);
  const row = rows[0];
  return row ? toRecord(row) : undefined;
}

export async function isMfaEnabled(db: MfaDb, provider: string, externalId: string): Promise<boolean> {
  const record = await getMfa(db, provider, externalId);
  return record?.enabled ?? false;
}

/** Store a fresh (disabled) secret, replacing any previous setup attempt. */
export async function storePendingMfa(
  db: MfaDb,
  provider: string,
  externalId: string,
  encrypted: { ciphertext: string; iv: string; tag: string },
): Promise<void> {
  await db.query(
    `INSERT INTO user_mfa (provider, external_id, secret_ciphertext, secret_iv, secret_tag, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, false, now())
     ON CONFLICT (provider, external_id)
     DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, secret_iv = EXCLUDED.secret_iv,
       secret_tag = EXCLUDED.secret_tag, enabled = false, updated_at = now()`,
    [provider, externalId, encrypted.ciphertext, encrypted.iv, encrypted.tag],
  );
  await db.query('DELETE FROM recovery_codes WHERE provider = $1 AND external_id = $2', [provider, externalId]);
}

export async function enableMfa(db: MfaDb, provider: string, externalId: string): Promise<string[]> {
  await db.query('UPDATE user_mfa SET enabled = true, updated_at = now() WHERE provider = $1 AND external_id = $2', [
    provider,
    externalId,
  ]);
  const codes = newRecoveryCodes();
  for (const code of codes) {
    await db.query('INSERT INTO recovery_codes (provider, external_id, code_hash) VALUES ($1, $2, $3)', [
      provider,
      externalId,
      hashAccountToken(normalizeRecoveryCode(code)),
    ]);
  }
  return codes;
}

export async function disableMfa(db: MfaDb, provider: string, externalId: string): Promise<void> {
  await db.query('DELETE FROM user_mfa WHERE provider = $1 AND external_id = $2', [provider, externalId]);
  await db.query('DELETE FROM recovery_codes WHERE provider = $1 AND external_id = $2', [provider, externalId]);
}

/** Consume one recovery code. Returns true only for a live, unused code. */
export async function consumeRecoveryCode(
  db: MfaDb,
  provider: string,
  externalId: string,
  code: string,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM recovery_codes WHERE provider = $1 AND external_id = $2 AND code_hash = $3 AND used_at IS NULL',
    [provider, externalId, hashAccountToken(normalizeRecoveryCode(code))],
  );
  const row = rows[0];
  if (!row) return false;
  await db.query('UPDATE recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL', [row.id]);
  return true;
}
