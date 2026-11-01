import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ApproverRole } from './auth.js';
import { findUserTenants, touchTenantUser } from '../tenants/store.js';
import {
  hashClientIp,
  listSessions,
  readSessionToken,
  revokeAllSessions,
  revokeSessionById,
  revokeSessionToken,
  rotateSession,
  sessionClearCookie,
  sessionSetCookie,
  verifySessionToken,
} from './session.js';
import { recordAuthEvent } from './audit.js';

/**
 * Session routes. These belong to session mode as a whole, not to any one
 * provider: /auth/me, tenant switching, logout, and the caller's own
 * session list live here so every provider (GitHub, Google, Apple,
 * credentials) gets identical behaviour.
 */
export interface SessionRoutesOptions {
  readonly ownerPool?: Pool | undefined;
}

export function registerSessionRoutes(app: FastifyInstance, opts: SessionRoutesOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';
  const pool = opts.ownerPool;

  async function currentSession(req: { headers: { cookie?: unknown } }) {
    if (!pool) return undefined;
    const cookie = req.headers.cookie;
    const token = readSessionToken(typeof cookie === 'string' ? cookie : undefined);
    if (!token) return undefined;
    return verifySessionToken(pool, token);
  }

  app.get('/auth/me', async (req, reply) => {
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ authenticated: false });
    let tenants: Array<{ tenantId: string; login: string; roles: readonly ApproverRole[] }> = [];
    if (pool) {
      const memberships = await findUserTenants(pool, session.provider, session.externalId);
      tenants = memberships.map((m) => ({ tenantId: m.tenantId, login: m.login, roles: m.roles }));
    }
    return {
      authenticated: true,
      login: session.login,
      roles: session.roles,
      tenantId: session.tenantId,
      provider: session.provider,
      sessionId: session.id,
      mfaVerified: session.mfaVerified,
      expiresAt: session.expiresAt.toISOString(),
      tenants,
    };
  });

  app.post<{ Body: { tenantId: string } }>('/auth/switch-tenant', async (req, reply) => {
    if (!pool) return reply.code(500).send({ error: 'config', detail: 'sessions require database' });
    const rawCookie = req.headers.cookie;
    const token = readSessionToken(typeof rawCookie === 'string' ? rawCookie : undefined);
    if (!token) return reply.code(401).send({ error: 'not authenticated' });
    const tenantId = (req.body as { tenantId?: string } | undefined)?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'tenantId required' });
    const current = await verifySessionToken(pool, token);
    if (!current) return reply.code(401).send({ error: 'session expired' });
    const memberships = await findUserTenants(pool, current.provider, current.externalId);
    const target = memberships.find((m) => m.tenantId === tenantId);
    if (!target) return reply.code(403).send({ error: 'not a member of that tenant' });
    await touchTenantUser(pool, current.provider, current.externalId, tenantId);
    const rotated = await rotateSession(pool, token, { tenantId, roles: target.roles });
    if (!rotated) return reply.code(401).send({ error: 'session expired' });
    await recordAuthEvent(pool, {
      tenantId,
      provider: current.provider,
      externalId: current.externalId,
      login: current.login,
      event: 'tenant_switched',
      ipHash: hashClientIp(req.ip),
    });
    void reply.header('set-cookie', sessionSetCookie(rotated.token, secure));
    return { ok: true, tenantId };
  });

  app.post<{ Body: { all?: boolean } }>('/auth/logout', async (req, reply) => {
    if (pool) {
      const rawCookie = req.headers.cookie;
      const token = readSessionToken(typeof rawCookie === 'string' ? rawCookie : undefined);
      if (token) {
        const session = await verifySessionToken(pool, token);
        if (session) {
          const body = req.body as { all?: boolean } | undefined;
          if (body?.all) {
            await revokeAllSessions(pool, session.provider, session.externalId);
          } else {
            await revokeSessionToken(pool, token);
          }
          await recordAuthEvent(pool, {
            tenantId: session.tenantId,
            provider: session.provider,
            externalId: session.externalId,
            login: session.login,
            event: 'logout',
            detail: { all: body?.all ?? false },
            ipHash: hashClientIp(req.ip),
          });
        }
      }
    }
    void reply.header('set-cookie', sessionClearCookie(secure));
    return { ok: true };
  });

  app.get('/auth/sessions', async (req, reply) => {
    if (!pool) return reply.code(500).send({ error: 'config', detail: 'sessions require database' });
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ error: 'not authenticated' });
    const sessions = await listSessions(pool, session.provider, session.externalId);
    return {
      items: sessions.map((s) => ({
        id: s.id,
        provider: s.provider,
        tenantId: s.tenantId,
        roles: s.roles,
        mfaVerified: s.mfaVerified,
        userAgent: s.userAgent,
        lastSeenAt: s.lastSeenAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.id === session.id,
      })),
    };
  });

  app.post<{ Params: { sessionId: string } }>('/auth/sessions/:sessionId/revoke', async (req, reply) => {
    if (!pool) return reply.code(500).send({ error: 'config', detail: 'sessions require database' });
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ error: 'not authenticated' });
    const revoked = await revokeSessionById(pool, session.provider, session.externalId, req.params.sessionId);
    if (!revoked) return reply.code(404).send({ error: 'not found', detail: 'no such live session' });
    await recordAuthEvent(pool, {
      tenantId: session.tenantId,
      provider: session.provider,
      externalId: session.externalId,
      login: session.login,
      event: 'session_revoked',
      detail: { sessionId: req.params.sessionId },
      ipHash: hashClientIp(req.ip),
    });
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-others', async (req, reply) => {
    if (!pool) return reply.code(500).send({ error: 'config', detail: 'sessions require database' });
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ error: 'not authenticated' });
    const count = await revokeAllSessions(pool, session.provider, session.externalId, session.id);
    await recordAuthEvent(pool, {
      tenantId: session.tenantId,
      provider: session.provider,
      externalId: session.externalId,
      login: session.login,
      event: 'session_revoked',
      detail: { others: true, revoked: count },
      ipHash: hashClientIp(req.ip),
    });
    return { ok: true, revoked: count };
  });
}
