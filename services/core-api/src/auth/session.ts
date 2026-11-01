import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Authenticator } from './auth.js';
import { AuthError, type ApproverRole } from './auth.js';
import { isApproverRole } from '../domain/index.js';

/**
 * Server-side sessions (Auth v2). The cookie carries only an opaque random
 * token; the server stores the token's SHA-256 hash, the identity, the
 * tenant, and the roles snapshot. That makes sessions revocable (one, or
 * all for a user), invisible to anyone reading the cookie, and immune to
 * SESSION_SECRET rotation: rotating the secret does not sign anyone out,
 * because nothing in the cookie is signed.
 *
 * Roles in a session are a snapshot from sign-in / tenant switch time.
 * Changing a membership's roles revokes that user's sessions in the
 * tenant, so the new roles take effect at the next sign-in. Never trust a
 * role from a request body: roles always come from a stored session row
 * or a fresh membership lookup.
 */

export const SESSION_COOKIE = 'iq_session';
/** Absolute session lifetime: 7 days. Revocation is the early-exit path. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
/** last_seen_at is refreshed at most this often, so auth checks stay cheap. */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

export type SessionDb = Pick<Pool, 'query'>;

export interface SessionIdentity {
  readonly provider: string;
  readonly externalId: string;
  readonly login: string;
  readonly tenantId: string;
  readonly roles: readonly ApproverRole[];
  readonly mfaVerified?: boolean | undefined;
}

export interface SessionRecord extends SessionIdentity {
  readonly id: string;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
  readonly userAgent: string | null;
  readonly ipHash: string | null;
  readonly createdAt: Date;
}

export interface SessionOptions {
  readonly sessionSecret: string;
}

interface SessionRow {
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

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    login: row.login,
    tenantId: row.tenant_id,
    roles: row.roles.filter(isApproverRole),
    mfaVerified: row.mfa_verified,
    userAgent: row.user_agent,
    ipHash: row.ip_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** The stored form of a token: SHA-256, hex. The raw token never hits the DB. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** One-way hash of a client address, for session listings. Never store raw IPs. */
export function hashClientIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export async function createSession(
  db: SessionDb,
  identity: SessionIdentity,
  opts: { userAgent?: string | undefined; ipHash?: string | undefined; ttlMs?: number } = {},
): Promise<{ record: SessionRecord; token: string }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? SESSION_TTL_MS));
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO sessions (token_hash, provider, external_id, login, tenant_id, roles, mfa_verified, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      hashSessionToken(token),
      identity.provider,
      identity.externalId,
      identity.login,
      identity.tenantId,
      [...identity.roles],
      identity.mfaVerified ?? false,
      opts.userAgent ?? null,
      opts.ipHash ?? null,
      expiresAt,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('session insert returned no row');
  return { record: toRecord(row), token };
}

/** Look a token up, rejecting expired and revoked sessions. */
export async function verifySessionToken(db: SessionDb, token: string): Promise<SessionRecord | undefined> {
  if (!token || token.length < 16) return undefined;
  const { rows } = await db.query<SessionRow>(
    `SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashSessionToken(token)],
  );
  const row = rows[0];
  if (!row) return undefined;
  const record = toRecord(row);
  if (Date.now() - record.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
    await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [record.id]).catch(() => undefined);
  }
  return record;
}

export async function revokeSessionToken(db: SessionDb, token: string): Promise<void> {
  if (!token) return;
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    hashSessionToken(token),
  ]);
}

export async function revokeSessionById(
  db: SessionDb,
  provider: string,
  externalId: string,
  sessionId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND provider = $2 AND external_id = $3 AND revoked_at IS NULL`,
    [sessionId, provider, externalId],
  );
  return (rowCount ?? 0) > 0;
}

/** Revoke every live session for one identity, optionally keeping one. Returns the count. */
export async function revokeAllSessions(
  db: SessionDb,
  provider: string,
  externalId: string,
  exceptId?: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE provider = $1 AND external_id = $2 AND revoked_at IS NULL AND expires_at > now()
     ${exceptId ? 'AND id <> $3' : ''}`,
    exceptId ? [provider, externalId, exceptId] : [provider, externalId],
  );
  return rowCount ?? 0;
}

/** Revoke every live session for one identity within one tenant, e.g. after a role change or removal there. Other tenants' sessions are untouched. */
export async function revokeSessionsForTenant(
  db: SessionDb,
  provider: string,
  externalId: string,
  tenantId: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE provider = $1 AND external_id = $2 AND tenant_id = $3 AND revoked_at IS NULL AND expires_at > now()`,
    [provider, externalId, tenantId],
  );
  return rowCount ?? 0;
}

export async function listSessions(db: SessionDb, provider: string, externalId: string): Promise<SessionRecord[]> {
  const { rows } = await db.query<SessionRow>(
    `SELECT * FROM sessions WHERE provider = $1 AND external_id = $2 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
    [provider, externalId],
  );
  return rows.map(toRecord);
}

/**
 * Replace one session with a fresh token carrying (optionally) a new
 * tenant/roles snapshot, e.g. tenant switch. The old token stops working.
 */
export async function rotateSession(
  db: SessionDb,
  oldToken: string,
  overrides: Partial<Pick<SessionIdentity, 'tenantId' | 'roles' | 'mfaVerified'>> = {},
): Promise<{ record: SessionRecord; token: string } | undefined> {
  const current = await verifySessionToken(db, oldToken);
  if (!current) return undefined;
  await revokeSessionToken(db, oldToken);
  return createSession(db, {
    provider: current.provider,
    externalId: current.externalId,
    login: current.login,
    tenantId: overrides.tenantId ?? current.tenantId,
    roles: overrides.roles ?? current.roles,
    mfaVerified: overrides.mfaVerified ?? current.mfaVerified,
  });
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  return parseCookie(cookieHeader, SESSION_COOKIE);
}

export function sessionSetCookie(token: string, secure: boolean, maxAgeSeconds: number = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`;
}

export function sessionClearCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function sessionAuthenticator(db: SessionDb | undefined): Authenticator {
  return {
    mode: 'github' as Authenticator['mode'],
    async authenticate(_authorization, cookie) {
      if (!db) throw new AuthError('sessions require database');
      const token = readSessionToken(cookie);
      if (!token) throw new AuthError('not authenticated: no session');
      const record = await verifySessionToken(db, token);
      if (!record) throw new AuthError('invalid or expired session');
      return {
        tenantId: record.tenantId,
        userId: record.login,
        roles: [...record.roles],
        provider: record.provider,
        externalId: record.externalId,
      };
    },
  };
}
