import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238, SHA-1, 30-second steps, 6 digits) with no dependencies.
 * Secrets are base32 (RFC 4648), the form authenticator apps accept.
 * Verification accepts the current step plus one step either side, so a
 * code typed near a boundary still works; each step is tried at most
 * once per call, and codes are compared in constant time.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(counterBytes).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const b0 = hmac[offset] ?? 0;
  const b1 = hmac[offset + 1] ?? 0;
  const b2 = hmac[offset + 2] ?? 0;
  const b3 = hmac[offset + 3] ?? 0;
  // Arithmetic, not bit shifts: the 31-bit value can set the sign bit,
  // which would make a bitwise result negative and break the modulo.
  const binary = (b0 & 0x7f) * 2 ** 24 + b1 * 2 ** 16 + b2 * 2 ** 8 + b3;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secretBase32: string, timeMs: number, digits = 6, stepSeconds = 30): string {
  const secret = base32Decode(secretBase32);
  const counter = BigInt(Math.floor(timeMs / 1000 / stepSeconds));
  return hotp(secret, counter, digits);
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  timeMs: number = Date.now(),
  digits = 6,
  stepSeconds = 30,
  window = 1,
): boolean {
  const clean = code.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return false;
  const secret = base32Decode(secretBase32);
  const counter = BigInt(Math.floor(timeMs / 1000 / stepSeconds));
  for (let delta = -window; delta <= window; delta += 1) {
    const step = counter + BigInt(delta);
    if (step < 0n) continue;
    const candidate = hotp(secret, step, digits);
    if (candidate.length === clean.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) {
      return true;
    }
  }
  return false;
}

export function otpauthUrl(issuer: string, login: string, secretBase32: string): string {
  const label = `${issuer}:${login}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, digits: '6', period: '30', algorithm: 'SHA1' });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
