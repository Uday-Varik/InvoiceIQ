import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { createClientSecret, type AppleAuthOptions } from '../src/auth/apple.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'test-session-secret-that-is-long-enough-32chars';
const TENANT = '00000000-0000-4000-8000-00000000d3e0';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const opts: AppleAuthOptions = {
  clientId: 'com.example.invoiceiq.signin',
  teamId: 'TEAM1234567',
  keyId: 'KEY1234567',
  privateKey: PRIVATE_PEM,
  sessionSecret: SECRET,
  defaultRole: 'cfo',
  tenantId: TENANT,
};

describe('createClientSecret', () => {
  it('signs an ES256 JWT Apple accepts, with a six-month lifetime', async () => {
    const secret = await createClientSecret(opts);
    const header = decodeProtectedHeader(secret);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('KEY1234567');

    const key = await importSPKI(PUBLIC_PEM, 'ES256');
    const { payload } = await jwtVerify(secret, key, {
      issuer: 'TEAM1234567',
      audience: 'https://appleid.apple.com',
    });
    expect(payload.sub).toBe('com.example.invoiceiq.signin');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp as number) - (payload.iat as number)).toBe(15777000);
  });

  it('fails with a key that is not an EC private key', async () => {
    await expect(
      createClientSecret({ ...opts, privateKey: 'not-a-key' }),
    ).rejects.toThrow();
  });
});

describe('Apple config validation', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://app:secret@localhost:5432/invoiceiq',
    MIGRATION_DATABASE_URL: 'postgres://owner:secret@localhost:5432/invoiceiq',
    AUTH_MODE: 'github',
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    SESSION_SECRET: SECRET,
    AI_SERVICE_URL: 'https://ai.example.test',
    AI_SIGNING_SECRET: 'ai-signing-secret-that-is-long-enough-32',
  };

  it('refuses a half-configured Apple provider', () => {
    expect(() => loadConfig({ ...baseEnv, APPLE_CLIENT_ID: 'com.example.invoiceiq.signin' })).toThrow(
      /APPLE_TEAM_ID is required when APPLE_CLIENT_ID is set/,
    );
  });

  it('accepts a fully configured Apple provider', () => {
    const config = loadConfig({
      ...baseEnv,
      APPLE_CLIENT_ID: 'com.example.invoiceiq.signin',
      APPLE_TEAM_ID: 'TEAM1234567',
      APPLE_KEY_ID: 'KEY1234567',
      APPLE_PRIVATE_KEY: PRIVATE_PEM,
    });
    expect(config.APPLE_CLIENT_ID).toBe('com.example.invoiceiq.signin');
  });

  it('accepts no Apple provider at all', () => {
    const config = loadConfig(baseEnv);
    expect(config.APPLE_CLIENT_ID).toBeUndefined();
  });
});
