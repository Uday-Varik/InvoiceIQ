import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSession,
  hashSessionToken,
  listSessions,
  revokeAllSessions,
  revokeSessionById,
  revokeSessionToken,
  rotateSession,
  sessionClearCookie,
  sessionSetCookie,
  verifySessionToken,
  type SessionDb,
} from '../src/auth/session.js';

interface Row {
  id: string;
  token_hash: string;
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

/** In-memory stand-in for the sessions table, keyed by token hash. */
function fakeDb(): { db: SessionDb; rows: Row[] } {
  const rows: Row[] = [];
  const db = {
    query: (async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO sessions')) {
        const row: Row = {
          id: randomUUID(),
          token_hash: params[0] as string,
          provider: params[1] as string,
          external_id: params[2] as string,
          login: params[3] as string,
          tenant_id: params[4] as string,
          roles: params[5] as string[],
          mfa_verified: params[6] as boolean,
          user_agent: params[7] as string | null,
          ip_hash: params[8] as string | null,
          created_at: new Date(),
          expires_at: params[9] as Date,
          last_seen_at: new Date(),
          revoked_at: null,
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('SET last_seen_at')) {
        const row = rows.find((r) => r.id === params[0]);
        if (row) row.last_seen_at = new Date();
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('SET revoked_at')) {
        let affected = 0;
        for (const row of rows) {
          const byHash = sql.includes('token_hash = $1') && row.token_hash === params[0];
          const byId = sql.includes('id = $1') && row.id === params[0] && row.provider === params[1] && row.external_id === params[2];
          const bulk =
            sql.includes('provider = $1') &&
            row.provider === params[0] &&
            row.external_id === params[1] &&
            (params.length < 3 || row.id !== params[2]);
          if ((byHash || byId || bulk) && !row.revoked_at && row.expires_at > new Date()) {
            row.revoked_at = new Date();
            affected += 1;
          }
        }
        return { rows: [], rowCount: affected };
      }
      if (sql.includes('FROM sessions')) {
        const live = rows.filter((r) => !r.revoked_at && r.expires_at > new Date());
        if (sql.includes('token_hash = $1')) {
          return { rows: live.filter((r) => r.token_hash === params[0]), rowCount: 1 };
        }
        return { rows: live.filter((r) => r.provider === params[0] && r.external_id === params[1]), rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as SessionDb['query'],
  };
  return { db, rows };
}

const IDENTITY = {
  provider: 'github',
  externalId: '12345',
  login: 'testuser',
  tenantId: '00000000-0000-4000-8000-00000000d3e0',
  roles: ['cfo'] as const,
};

describe('server-side sessions', () => {
  it('creates a token whose hash, not the token, is stored', async () => {
    const { db, rows } = fakeDb();
    const { record, token } = await createSession(db, IDENTITY);
    expect(token.length).toBeGreaterThan(20);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashSessionToken(token));
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(record.login).toBe('testuser');
    expect(record.roles).toEqual(['cfo']);
  });

  it('verifies a live token and rejects the hash itself as a token', async () => {
    const { db } = fakeDb();
    const { token } = await createSession(db, IDENTITY);
    expect(await verifySessionToken(db, token)).toBeDefined();
    expect(await verifySessionToken(db, hashSessionToken(token))).toBeUndefined();
    expect(await verifySessionToken(db, '')).toBeUndefined();
  });

  it('rejects expired sessions', async () => {
    const { db } = fakeDb();
    const { token } = await createSession(db, IDENTITY, { ttlMs: -1000 });
    expect(await verifySessionToken(db, token)).toBeUndefined();
  });

  it('revokes one token without touching others', async () => {
    const { db } = fakeDb();
    const a = await createSession(db, IDENTITY);
    const b = await createSession(db, IDENTITY);
    await revokeSessionToken(db, a.token);
    expect(await verifySessionToken(db, a.token)).toBeUndefined();
    expect(await verifySessionToken(db, b.token)).toBeDefined();
  });

  it('rotates a session: old token dies, new token carries overrides', async () => {
    const { db } = fakeDb();
    const { token } = await createSession(db, IDENTITY);
    const rotated = await rotateSession(db, token, {
      tenantId: '00000000-0000-4000-8000-00000000d3e1',
      roles: ['controller'],
    });
    expect(rotated).toBeDefined();
    expect(await verifySessionToken(db, token)).toBeUndefined();
    const record = await verifySessionToken(db, rotated!.token);
    expect(record?.tenantId).toBe('00000000-0000-4000-8000-00000000d3e1');
    expect(record?.roles).toEqual(['controller']);
    expect(await rotateSession(db, token)).toBeUndefined();
  });

  it('revokes all sessions for a user, optionally keeping one', async () => {
    const { db } = fakeDb();
    const a = await createSession(db, IDENTITY);
    const b = await createSession(db, IDENTITY);
    const kept = await createSession(db, IDENTITY);
    const count = await revokeAllSessions(db, 'github', '12345', kept.record.id);
    expect(count).toBe(2);
    expect(await verifySessionToken(db, a.token)).toBeUndefined();
    expect(await verifySessionToken(db, b.token)).toBeUndefined();
    expect(await verifySessionToken(db, kept.token)).toBeDefined();
  });

  it('revokes by id only for the owning identity', async () => {
    const { db } = fakeDb();
    const { record } = await createSession(db, IDENTITY);
    expect(await revokeSessionById(db, 'google', '12345', record.id)).toBe(false);
    expect(await revokeSessionById(db, 'github', '12345', record.id)).toBe(true);
    expect(await revokeSessionById(db, 'github', '12345', record.id)).toBe(false);
  });

  it('lists live sessions, newest activity first', async () => {
    const { db } = fakeDb();
    const a = await createSession(db, IDENTITY);
    await createSession(db, { ...IDENTITY, provider: 'google', externalId: '999' });
    const b = await createSession(db, IDENTITY);
    await revokeSessionToken(db, a.token);
    const items = await listSessions(db, 'github', '12345');
    expect(items.map((s) => s.id)).toEqual([b.record.id]);
  });

  it('cookie headers are HttpOnly, Lax, and Secure only in production', () => {
    const set = sessionSetCookie('tok', true);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Secure');
    expect(sessionSetCookie('tok', false)).not.toContain('Secure');
    expect(sessionClearCookie(true)).toContain('Max-Age=0');
  });

  it('hashing is deterministic and collision-free across tokens', () => {
    expect(hashSessionToken('a')).toBe(hashSessionToken('a'));
    expect(hashSessionToken('a')).not.toBe(hashSessionToken('b'));
  });
});
