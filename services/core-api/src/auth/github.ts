import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Authenticator } from './auth.js';
import { AuthError, type ApproverRole } from './auth.js';

const SESSION_COOKIE = 'iq_session';
const STATE_COOKIE = 'iq_oauth_state';

export interface GitHubAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly callbackUrl?: string | undefined;
  readonly defaultRole: ApproverRole;
  readonly tenantId: string;
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

export function registerGitHubAuthRoutes(app: FastifyInstance, opts: GitHubAuthOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';
  const cookieOpts = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const sessionMaxAge = 7 * 24 * 60 * 60;

  app.get('/auth/github', async (_req, reply) => {
    const state = randomBytes(24).toString('base64url');
    void reply.header('set-cookie', `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
    const params = new URLSearchParams({
      client_id: opts.clientId,
      scope: 'read:user',
      state,
      ...(opts.callbackUrl ? { redirect_uri: opts.callbackUrl } : {}),
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

      const payload: SessionPayload = {
        uid: String(ghUser.id),
        login: ghUser.login,
        tid: opts.tenantId,
        roles: [opts.defaultRole],
        exp: Date.now() + sessionMaxAge * 1000,
      };
      const session = sign(payload, opts.sessionSecret);

      void reply.header('set-cookie', `${SESSION_COOKIE}=${session}; ${cookieOpts}; Max-Age=${sessionMaxAge}`);
      return reply.redirect('/');
    },
  );

  app.get('/auth/me', async (req, reply) => {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return reply.code(401).send({ authenticated: false });
    const payload = verify(token, opts.sessionSecret);
    if (!payload) return reply.code(401).send({ authenticated: false });
    return { authenticated: true, login: payload.login, roles: payload.roles };
  });

  app.post('/auth/logout', async (_req, reply) => {
    void reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    return { ok: true };
  });
}
