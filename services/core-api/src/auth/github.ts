import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Authenticator } from './auth.js';
import { AuthError, type ApproverRole } from './auth.js';
import type { Pool } from 'pg';
import { findUserTenants, upsertTenantUser, touchTenantUser } from '../tenants/store.js';

const SESSION_COOKIE = 'iq_session';
const STATE_COOKIE = 'iq_oauth_state';

export interface GitHubAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly callbackUrl?: string | undefined;
  readonly frontendUrl?: string | undefined;
  readonly defaultRole: ApproverRole;
  readonly tenantId: string;
  /** Owner-role pool for tenant_users lookups (multi-tenant). */
  readonly ownerPool?: Pool | undefined;
}

interface SessionPayload {
  readonly uid: string;
  readonly login: string;
  readonly tid: string;
  readonly roles: readonly ApproverRole[];
  readonly exp: number;
}

function sign(payload: SessionPayload, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function verify(token: string, secret: string): SessionPayload | undefined {
  const dot = token.indexOf('.');
  if (dot < 1) return undefined;
  const data = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export function githubAuthenticator(opts: GitHubAuthOptions): Authenticator {
  return {
    mode: 'github' as Authenticator['mode'],
    async authenticate(authorization, cookie) {
      const token = parseCookie(cookie, SESSION_COOKIE);
      if (!token) throw new AuthError('not authenticated: no session');
      const payload = verify(token, opts.sessionSecret);
      if (!payload) throw new AuthError('invalid or expired session');
      return {
        tenantId: payload.tid,
        userId: payload.login,
        roles: [...payload.roles],
      };
    },
  };
}

async function exchangeCode(clientId: string, clientSecret: string, code: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (body.error || !body.access_token) throw new Error(body.error_description ?? body.error ?? 'no access_token');
  return body.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<{ id: number; login: string }> {
  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'InvoiceIQ' },
  });
  if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
  const body = (await res.json()) as { id: number; login: string };
  if (!body.login || typeof body.id !== 'number') throw new Error('invalid GitHub user response');
  return body;
}

function requestOrigin(req: FastifyRequest): string {
  const proto = req.protocol;
  const host = req.hostname;
  return `${proto}://${host}`;
}

export function registerGitHubAuthRoutes(app: FastifyInstance, opts: GitHubAuthOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';
  const cookieOpts = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const sessionMaxAge = 7 * 24 * 60 * 60;

  app.get('/auth/github', async (req, reply) => {
    const state = randomBytes(24).toString('base64url');
    void reply.header('set-cookie', `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
    const callbackUrl = opts.callbackUrl ?? `${requestOrigin(req)}/auth/github/callback`;
    const params = new URLSearchParams({
      client_id: opts.clientId,
      scope: 'read:user',
      state,
      redirect_uri: callbackUrl,
    });
    return reply.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/github/callback',
    async (req: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>, reply: FastifyReply) => {
      void reply.header('set-cookie', `${STATE_COOKIE}=; Path=/; Max-Age=0`);

      if (req.query.error) {
        return reply.code(401).send({ error: 'oauth_error', detail: req.query.error });
      }

      const expectedState = parseCookie(req.headers.cookie, STATE_COOKIE);
      if (!expectedState || !req.query.state || expectedState !== req.query.state) {
        return reply.code(400).send({ error: 'invalid_state', detail: 'OAuth state mismatch' });
      }

      if (!req.query.code) {
        return reply.code(400).send({ error: 'missing_code', detail: 'no authorization code' });
      }

      const accessToken = await exchangeCode(opts.clientId, opts.clientSecret, req.query.code);
      const ghUser = await fetchGitHubUser(accessToken);

      let tid = opts.tenantId;
      let roles: readonly ApproverRole[] = [opts.defaultRole];
      let redirectTo = opts.frontendUrl ?? '/';

      if (opts.ownerPool) {
        const memberships = await findUserTenants(opts.ownerPool, 'github', String(ghUser.id));
        const first = memberships[0];
        if (memberships.length === 1 && first) {
          tid = first.tenantId;
          roles = first.roles;
          await touchTenantUser(opts.ownerPool, 'github', String(ghUser.id), tid);
        } else if (memberships.length > 1 && first) {
          tid = first.tenantId;
          roles = first.roles;
          await touchTenantUser(opts.ownerPool, 'github', String(ghUser.id), tid);
        } else {
          // No membership: redirect to onboarding
          redirectTo = (opts.frontendUrl ?? '') + '/onboarding';
          // Create a membership in the default tenant
          const membership = await upsertTenantUser(opts.ownerPool, {
            tenantId: opts.tenantId,
            provider: 'github',
            externalId: String(ghUser.id),
            login: ghUser.login,
            roles: [opts.defaultRole],
          });
          tid = membership.tenantId;
          roles = membership.roles;
        }
      }

      const payload: SessionPayload = {
        uid: String(ghUser.id),
        login: ghUser.login,
        tid,
        roles: [...roles],
        exp: Date.now() + sessionMaxAge * 1000,
      };
      const session = sign(payload, opts.sessionSecret);

      void reply.header('set-cookie', `${SESSION_COOKIE}=${session}; ${cookieOpts}; Max-Age=${sessionMaxAge}`);
      return reply.redirect(redirectTo);
    },
  );

  app.get('/auth/me', async (req, reply) => {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return reply.code(401).send({ authenticated: false });
    const payload = verify(token, opts.sessionSecret);
    if (!payload) return reply.code(401).send({ authenticated: false });
    let tenants: Array<{ tenantId: string; login: string; roles: readonly ApproverRole[] }> = [];
    if (opts.ownerPool) {
      const memberships = await findUserTenants(opts.ownerPool, 'github', payload.uid);
      tenants = memberships.map((m) => ({ tenantId: m.tenantId, login: m.login, roles: m.roles }));
    }
    return { authenticated: true, login: payload.login, roles: payload.roles, tenantId: payload.tid, tenants };
  });

  app.post<{ Body: { tenantId: string } }>('/auth/switch-tenant', async (req, reply) => {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return reply.code(401).send({ error: 'not authenticated' });
    const current = verify(token, opts.sessionSecret);
    if (!current) return reply.code(401).send({ error: 'session expired' });
    if (!opts.ownerPool) return reply.code(400).send({ error: 'multi-tenant not enabled' });
    const tenantId = (req.body as { tenantId?: string })?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'tenantId required' });
    const memberships = await findUserTenants(opts.ownerPool, 'github', current.uid);
    const target = memberships.find((m) => m.tenantId === tenantId);
    if (!target) return reply.code(403).send({ error: 'not a member of that tenant' });
    await touchTenantUser(opts.ownerPool, 'github', current.uid, tenantId);
    const newPayload: SessionPayload = { uid: current.uid, login: current.login, tid: tenantId, roles: [...target.roles], exp: Date.now() + sessionMaxAge * 1000 };
    const session = sign(newPayload, opts.sessionSecret);
    void reply.header('set-cookie', `${SESSION_COOKIE}=${session}; ${cookieOpts}; Max-Age=${sessionMaxAge}`);
    return { ok: true, tenantId };
  });

  app.post('/auth/logout', async (_req, reply) => {
    void reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    return { ok: true };
  });
}
