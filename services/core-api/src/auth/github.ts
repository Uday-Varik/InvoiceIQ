import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApproverRole } from './auth.js';
import type { Pool } from 'pg';
import { findUserTenants, upsertTenantUser, touchTenantUser } from '../tenants/store.js';
import { createSession, hashClientIp, parseCookie, sessionSetCookie } from './session.js';
import { isMfaEnabled } from './mfa.js';
import { mfaPendingSetCookie, signMfaPending } from './tokens.js';

const STATE_COOKIE = 'iq_oauth_state';

export interface GitHubAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly callbackUrl?: string | undefined;
  readonly frontendUrl?: string | undefined;
  readonly defaultRole: ApproverRole;
  readonly tenantId: string;
  readonly ownerPool?: Pool | undefined;
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
  return `${req.protocol}://${req.hostname}`;
}

export function registerGitHubAuthRoutes(app: FastifyInstance, opts: GitHubAuthOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';

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
      let redirectTo = opts.frontendUrl ? `${opts.frontendUrl}/dashboard` : '/dashboard';

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
          redirectTo = (opts.frontendUrl ?? '') + '/onboarding';
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

      if (!opts.ownerPool) throw new Error('sessions require database');
      if (await isMfaEnabled(opts.ownerPool, 'github', String(ghUser.id))) {
        const pending = signMfaPending(
          { uid: String(ghUser.id), provider: 'github', login: ghUser.login, tid, roles: [...roles] },
          opts.sessionSecret,
        );
        void reply.header('set-cookie', mfaPendingSetCookie(pending, secure));
        return reply.redirect(`${opts.frontendUrl ?? ''}/login?mfa=1`);
      }
      const { token } = await createSession(
        opts.ownerPool,
        {
          provider: 'github',
          externalId: String(ghUser.id),
          login: ghUser.login,
          tenantId: tid,
          roles: [...roles],
        },
        { userAgent: req.headers['user-agent'], ipHash: hashClientIp(req.ip) },
      );

      void reply.header('set-cookie', sessionSetCookie(token, secure));
      return reply.redirect(redirectTo);
    },
  );
}
