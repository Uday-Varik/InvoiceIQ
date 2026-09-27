import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { githubAuthenticator, type GitHubAuthOptions } from '../src/auth/github.js';
import { AuthError } from '../src/auth/auth.js';

const SECRET = 'test-session-secret-that-is-long-enough-32chars';
const TENANT = '00000000-0000-4000-8000-00000000d3e0';

const opts: GitHubAuthOptions = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  sessionSecret: SECRET,
  defaultRole: 'cfo',
  tenantId: TENANT,
};

function sign(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function validPayload(overrides: Partial<{ uid: string; login: string; tid: string; roles: string[]; exp: number }> = {}) {
  return {
    uid: '12345',
    login: 'testuser',
    tid: TENANT,
    roles: ['cfo'],
    exp: Date.now() + 3600_000,
    ...overrides,
  };
}

describe('githubAuthenticator', () => {
  const auth = githubAuthenticator(opts);

  it('has mode "github"', () => {
    expect(auth.mode).toBe('github');
  });

  it('rejects when no session cookie is present', async () => {
    await expect(auth.authenticate(undefined, undefined)).rejects.toThrow(AuthError);
  });

  it('rejects an empty cookie header', async () => {
    await expect(auth.authenticate(undefined, '')).rejects.toThrow(AuthError);
  });

  it('rejects a tampered session token', async () => {
    const token = sign(validPayload()) + 'x';
    const cookie = `iq_session=${token}`;
    await expect(auth.authenticate(undefined, cookie)).rejects.toThrow(AuthError);
  });

  it('rejects an expired session', async () => {
    const token = sign(validPayload({ exp: Date.now() - 1000 }));
    const cookie = `iq_session=${token}`;
    await expect(auth.authenticate(undefined, cookie)).rejects.toThrow(AuthError);
  });

  it('authenticates a valid session cookie', async () => {
    const token = sign(validPayload());
    const cookie = `iq_session=${token}`;
    const principal = await auth.authenticate(undefined, cookie);
    expect(principal.tenantId).toBe(TENANT);
    expect(principal.userId).toBe('testuser');
    expect(principal.roles).toEqual(['cfo']);
  });

  it('reads the session cookie among other cookies', async () => {
    const token = sign(validPayload({ login: 'multiuser' }));
    const cookie = `other=value; iq_session=${token}; foo=bar`;
    const principal = await auth.authenticate(undefined, cookie);
    expect(principal.userId).toBe('multiuser');
  });

  it('ignores Authorization header (session is in cookies)', async () => {
    const token = sign(validPayload());
    const cookie = `iq_session=${token}`;
    const principal = await auth.authenticate('Bearer something-else', cookie);
    expect(principal.userId).toBe('testuser');
  });
});
