import { describe, expect, it } from 'vitest';
import { sessionAuthenticator } from '../src/auth/session.js';
import { hashSessionToken, type SessionDb } from '../src/auth/session.js';
import { AuthError } from '../src/auth/auth.js';

const TENANT = '00000000-0000-4000-00000000d3e0';

interface Row {
  id: string;
  provider: string;
  external_id: string;
  login: string;
  tenant_id: string;
  roles: string[];
  mfa_verified: boolean;
  user_agent: string | null;
  ip_hash: string | null;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'github',
    external_id: '12345',
    login: 'testuser',
    tenant_id: TENANT,
    roles: ['cfo'],
    mfa_verified: false,
    user_agent: null,
    ip_hash: null,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 3600_000),
    last_seen_at: new Date(),
    revoked_at: null,
    ...overrides,
  };
}

/** A session store backed by one in-memory row, keyed by token hash. */
function fakeDb(session: Row | undefined): SessionDb {
  return {
    query: (async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM sessions')) {
        const hash = params?.[0];
        if (session && hash === hashSessionToken('valid-token') && !session.revoked_at && session.expires_at > new Date()) {
          return { rows: [session] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    }) as SessionDb['query'],
  };
}

describe('sessionAuthenticator (server-side sessions)', () => {
  it('has mode "github"', () => {
    expect(sessionAuthenticator(fakeDb(row())).mode).toBe('github');
  });

  it('accepts a live session token', async () => {
    const auth = sessionAuthenticator(fakeDb(row()));
    const principal = await auth.authenticate(undefined, 'iq_session=valid-token');
    expect(principal.tenantId).toBe(TENANT);
    expect(principal.userId).toBe('testuser');
    expect(principal.roles).toEqual(['cfo']);
  });

  it('rejects when no session cookie is present', async () => {
    const auth = sessionAuthenticator(fakeDb(row()));
    await expect(auth.authenticate(undefined, undefined)).rejects.toThrow(AuthError);
  });

  it('rejects an empty cookie header', async () => {
    const auth = sessionAuthenticator(fakeDb(row()));
    await expect(auth.authenticate(undefined, '')).rejects.toThrow(AuthError);
  });

  it('rejects an unknown token', async () => {
    const auth = sessionAuthenticator(fakeDb(row()));
    await expect(auth.authenticate(undefined, 'iq_session=nope')).rejects.toThrow(AuthError);
  });

  it('rejects an expired session', async () => {
    const auth = sessionAuthenticator(fakeDb(row({ expires_at: new Date(Date.now() - 1000) })));
    await expect(auth.authenticate(undefined, 'iq_session=valid-token')).rejects.toThrow(AuthError);
  });

  it('rejects a revoked session', async () => {
    const auth = sessionAuthenticator(fakeDb(row({ revoked_at: new Date() })));
    await expect(auth.authenticate(undefined, 'iq_session=valid-token')).rejects.toThrow(AuthError);
  });

  it('rejects when there is no session database', async () => {
    const auth = sessionAuthenticator(undefined);
    await expect(auth.authenticate(undefined, 'iq_session=valid-token')).rejects.toThrow(AuthError);
  });
});
