import { randomBytes } from 'node:crypto';
import { parse as parseQueryString } from 'node:querystring';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';
import type { ApproverRole } from './auth.js';
import type { Pool } from 'pg';
import { findUserTenants, upsertTenantUser, touchTenantUser } from '../tenants/store.js';
import { createSession, hashClientIp, parseCookie, sessionSetCookie } from './session.js';
import { isMfaEnabled } from './mfa.js';
import { recordAuthEvent } from './audit.js';
import { mfaPendingSetCookie, signMfaPending } from './tokens.js';

const STATE_COOKIE = 'iq_apple_oauth_state';
const NONCE_COOKIE = 'iq_apple_oauth_nonce';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
/** Apple client secrets may live at most six months (15777000 seconds). */
const CLIENT_SECRET_LIFETIME_SECONDS = 15777000;

export interface AppleAuthOptions {
  readonly clientId: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly sessionSecret: string;
  readonly callbackUrl?: string | undefined;
  readonly frontendUrl?: string | undefined;
  readonly defaultRole: ApproverRole;
  readonly tenantId: string;
  readonly ownerPool?: Pool | undefined;
}

/**
 * Apple's client_secret is a JWT signed with the Service ID private key
 * (ES256, .p8 PKCS#8 PEM). It is generated per token exchange so a rotated
 * key takes effect without a restart.
 */
export async function createClientSecret(opts: Pick<AppleAuthOptions, 'clientId' | 'teamId' | 'keyId' | 'privateKey'>): Promise<string> {
  // Dashboards sometimes store the .p8 PEM with literal \n sequences instead
  // of real newlines; normalize that one case, leave real PEMs untouched.
  const pem =
    opts.privateKey.includes('\\n') && !opts.privateKey.includes('\n')
      ? opts.privateKey.replace(/\\n/g, '\n')
      : opts.privateKey;
  const key = await importPKCS8(pem, 'ES256');
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: opts.keyId, typ: 'JWT' })
    .setIssuer(opts.teamId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + CLIENT_SECRET_LIFETIME_SECONDS)
    .setAudience(APPLE_ISSUER)
    .setSubject(opts.clientId)
    .sign(key);
}

async function exchangeAppleCode(
  opts: AppleAuthOptions,
  code: string,
  redirectUri: string,
): Promise<{ idToken: string }> {
  const clientSecret = await createClientSecret(opts);
  const res = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Apple token exchange failed: ${res.status}`);
  const body = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
  if (body.error || !body.id_token) throw new Error(body.error_description ?? body.error ?? 'no id_token');
  return { idToken: body.id_token };
}

interface AppleIdToken {
  readonly sub: string;
  readonly email?: string | undefined;
  readonly nonce?: string | undefined;
}

async function verifyIdToken(idToken: string, opts: AppleAuthOptions, expectedNonce: string): Promise<AppleIdToken> {
  const keys = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: APPLE_ISSUER,
    audience: opts.clientId,
    algorithms: ['RS256'],
    clockTolerance: 30,
    requiredClaims: ['sub', 'exp', 'aud', 'iss'],
  });
  const sub = payload['sub'];
  if (typeof sub !== 'string' || !sub) throw new Error('invalid Apple id_token: no sub');
  if (payload['nonce'] !== expectedNonce) throw new Error('invalid Apple id_token: nonce mismatch');
  const email = payload['email'];
  return {
    sub,
    ...(typeof email === 'string' && email ? { email } : {}),
    ...(typeof payload['nonce'] === 'string' ? { nonce: payload['nonce'] } : {}),
  };
}

function requestOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.hostname}`;
}

function formValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function registerAppleAuthRoutes(app: FastifyInstance, opts: AppleAuthOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';

  // Apple posts the callback as application/x-www-form-urlencoded (form_post).
  // No form-body plugin is installed, so parse it with the Node querystring
  // parser. This instance has no other urlencoded parser registered.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        done(null, parseQueryString(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get('/auth/apple', async (req, reply) => {
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    void reply.header('set-cookie', [
      `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
      `${NONCE_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
    ]);
    const callbackUrl = opts.callbackUrl ?? `${requestOrigin(req)}/auth/apple/callback`;
    const params = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'name email',
      response_mode: 'form_post',
      state,
      nonce,
    });
    return reply.redirect(`https://appleid.apple.com/auth/authorize?${params.toString()}`);
  });

  app.post<{ Body: Record<string, string | string[] | undefined> }>(
    '/auth/apple/callback',
    async (req: FastifyRequest<{ Body: Record<string, string | string[] | undefined> }>, reply: FastifyReply) => {
      void reply.header('set-cookie', [
        `${STATE_COOKIE}=; Path=/; Max-Age=0`,
        `${NONCE_COOKIE}=; Path=/; Max-Age=0`,
      ]);

      const body = req.body ?? {};
      const error = formValue(body['error']);
      if (error) {
        return reply.code(401).send({ error: 'oauth_error', detail: error });
      }

      const expectedState = parseCookie(req.headers.cookie, STATE_COOKIE);
      const expectedNonce = parseCookie(req.headers.cookie, NONCE_COOKIE);
      const state = formValue(body['state']);
      if (!expectedState || !state || expectedState !== state) {
        return reply.code(400).send({ error: 'invalid_state', detail: 'OAuth state mismatch' });
      }
      if (!expectedNonce) {
        return reply.code(400).send({ error: 'invalid_nonce', detail: 'OAuth nonce missing' });
      }

      const code = formValue(body['code']);
      if (!code) {
        return reply.code(400).send({ error: 'missing_code', detail: 'no authorization code' });
      }

      const callbackUrl = opts.callbackUrl ?? `${requestOrigin(req)}/auth/apple/callback`;
      const { idToken } = await exchangeAppleCode(opts, code, callbackUrl);
      const appleUser = await verifyIdToken(idToken, opts, expectedNonce);

      let tid = opts.tenantId;
      let roles: readonly ApproverRole[] = [opts.defaultRole];
      let redirectTo = opts.frontendUrl ? `${opts.frontendUrl}/dashboard` : '/dashboard';

      if (opts.ownerPool) {
        const memberships = await findUserTenants(opts.ownerPool, 'apple', appleUser.sub);
        const first = memberships[0];
        if (memberships.length >= 1 && first) {
          tid = first.tenantId;
          roles = first.roles;
          await touchTenantUser(opts.ownerPool, 'apple', appleUser.sub, tid);
        } else {
          redirectTo = (opts.frontendUrl ?? '') + '/onboarding';
          const membership = await upsertTenantUser(opts.ownerPool, {
            tenantId: opts.tenantId,
            provider: 'apple',
            externalId: appleUser.sub,
            login: appleUser.email ?? appleUser.sub,
            roles: [opts.defaultRole],
          });
          tid = membership.tenantId;
          roles = membership.roles;
        }
      }

      if (!opts.ownerPool) throw new Error('sessions require database');
      if (await isMfaEnabled(opts.ownerPool, 'apple', appleUser.sub)) {
        const pending = signMfaPending(
          { uid: appleUser.sub, provider: 'apple', login: appleUser.email ?? appleUser.sub, tid, roles: [...roles] },
          opts.sessionSecret,
        );
        void reply.header('set-cookie', mfaPendingSetCookie(pending, secure));
        return reply.redirect(`${opts.frontendUrl ?? ''}/login?mfa=1`);
      }
      const { token } = await createSession(
        opts.ownerPool,
        {
          provider: 'apple',
          externalId: appleUser.sub,
          login: appleUser.email ?? appleUser.sub,
          tenantId: tid,
          roles: [...roles],
        },
        { userAgent: req.headers['user-agent'], ipHash: hashClientIp(req.ip) },
      );

      await recordAuthEvent(opts.ownerPool, {
        tenantId: tid,
        provider: 'apple',
        externalId: appleUser.sub,
        login: appleUser.email ?? appleUser.sub,
        event: 'login',
        ipHash: hashClientIp(req.ip),
      });
      void reply.header('set-cookie', sessionSetCookie(token, secure));
      return reply.redirect(redirectTo);
    },
  );
}
