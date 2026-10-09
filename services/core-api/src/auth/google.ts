import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ApproverRole } from './auth.js';
import { findUserTenants, upsertTenantUser, touchTenantUser } from '../tenants/store.js';
import { signSession, type SessionOptions } from './session.js';

export interface GoogleAuthOptions extends SessionOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl?: string | undefined;
  readonly frontendUrl?: string | undefined;
  readonly defaultRole: ApproverRole;
  readonly tenantId: string;
  readonly ownerPool?: Pool | undefined;
}

const STATE_COOKIE = 'iq_google_oauth_state';

async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; id_token: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string; id_token?: string; error?: string };
  if (body.error || !body.access_token) throw new Error(body.error ?? 'no access_token');
  return { access_token: body.access_token, id_token: body.id_token ?? '' };
}

async function fetchGoogleUser(accessToken: string): Promise<{ id: string; email: string; name: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google user fetch failed: ${res.status}`);
  const body = (await res.json()) as { id: string; email: string; name: string };
  if (!body.email || !body.id) throw new Error('invalid Google user response');
  return body;
}

function requestOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.hostname}`;
}

export function registerGoogleAuthRoutes(app: FastifyInstance, opts: GoogleAuthOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';
  const cookieOpts = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const sessionMaxAge = 7 * 24 * 60 * 60;

  app.get('/auth/google', async (req, reply) => {
    const state = randomBytes(24).toString('base64url');
    void reply.header(
      'set-cookie',
      `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
    );
    const callbackUrl = opts.callbackUrl ?? `${requestOrigin(req)}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: opts.clientId,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      redirect_uri: callbackUrl,
      access_type: 'offline',
      prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    async (
      req: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>,
      reply: FastifyReply,
    ) => {
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

      const callbackUrl = opts.callbackUrl ?? `${requestOrigin(req)}/auth/google/callback`;
      const tokens = await exchangeGoogleCode(opts.clientId, opts.clientSecret, req.query.code, callbackUrl);
      const googleUser = await fetchGoogleUser(tokens.access_token);

      let tid = opts.tenantId;
      let roles: readonly ApproverRole[] = [opts.defaultRole];
      let redirectTo = opts.frontendUrl ?? '/';

      if (opts.ownerPool) {
        const memberships = await findUserTenants(opts.ownerPool, 'google', googleUser.id);
        const first = memberships[0];
        if (memberships.length >= 1 && first) {
          tid = first.tenantId;
          roles = first.roles;
          await touchTenantUser(opts.ownerPool, 'google', googleUser.id, tid);
        } else {
          redirectTo = (opts.frontendUrl ?? '') + '/onboarding';
          const membership = await upsertTenantUser(opts.ownerPool, {
            tenantId: opts.tenantId,
            provider: 'google',
            externalId: googleUser.id,
            login: googleUser.email,
            roles: [opts.defaultRole],
          });
          tid = membership.tenantId;
          roles = membership.roles;
        }
      }

      const session = signSession(
        {
          uid: googleUser.id,
          login: googleUser.email,
          tid,
          roles: [...roles],
          provider: 'google',
          exp: Date.now() + sessionMaxAge * 1000,
        },
        opts.sessionSecret,
      );

      void reply.header('set-cookie', `iq_session=${session}; ${cookieOpts}; Max-Age=${sessionMaxAge}`);
      return reply.redirect(redirectTo);
    },
  );
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
