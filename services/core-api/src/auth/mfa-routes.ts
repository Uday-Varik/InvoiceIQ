import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { MFA_PENDING_COOKIE, mfaPendingClearCookie, verifyMfaPending } from './tokens.js';
import {
  consumeRecoveryCode,
  decryptTotpSecret,
  deriveMfaKey,
  disableMfa,
  enableMfa,
  encryptTotpSecret,
  getMfa,
  isMfaEnabled,
  newTotpSecret,
  storePendingMfa,
  type MfaDb,
} from './mfa.js';
import { otpauthUrl, verifyTotp } from './totp.js';
import {
  createSession,
  hashClientIp,
  parseCookie,
  readSessionToken,
  sessionSetCookie,
  verifySessionToken,
} from './session.js';

/**
 * MFA (TOTP) account routes. Setup is two-step on purpose: the secret is
 * stored disabled until a code from the authenticator app proves the
 * user can generate codes, and the recovery codes are shown exactly
 * once, at enable time. Sign-in step-up happens in the provider
 * callbacks and credential login, which issue a short-lived pending
 * token; /auth/mfa/challenge exchanges it for a session.
 */

export interface MfaRoutesOptions {
  readonly ownerPool?: Pool | undefined;
  readonly sessionSecret: string;
  /** Dedicated MFA encryption key; falls back to the session secret. */
  readonly mfaSecret?: string | undefined;
}

export function registerMfaRoutes(app: FastifyInstance, opts: MfaRoutesOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';
  const pool: MfaDb | undefined = opts.ownerPool;
  const key = deriveMfaKey(opts.mfaSecret ?? opts.sessionSecret);

  async function currentSession(req: { headers: { cookie?: unknown } }) {
    if (!pool) return undefined;
    const token = readSessionToken(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
    if (!token) return undefined;
    return verifySessionToken(pool, token);
  }

  function requirePool(reply: FastifyReply): MfaDb | undefined {
    if (!pool) {
      void reply.code(500).send({ error: 'config', detail: 'MFA requires database' });
      return undefined;
    }
    return pool;
  }

  app.get('/auth/mfa/status', async (req, reply) => {
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ error: 'not authenticated' });
    const db = requirePool(reply);
    if (!db) return;
    return { enabled: await isMfaEnabled(db, session.provider, session.externalId) };
  });

  app.post('/auth/mfa/setup', async (req, reply) => {
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ error: 'not authenticated' });
    const db = requirePool(reply);
    if (!db) return;
    const existing = await getMfa(db, session.provider, session.externalId);
    if (existing?.enabled) {
      return reply.code(409).send({
        error: 'mfa_already_enabled',
        detail: 'disable two-factor authentication first, then set it up again',
      });
    }
    const secret = newTotpSecret();
    await storePendingMfa(db, session.provider, session.externalId, encryptTotpSecret(secret, key));
    return { otpauthUrl: otpauthUrl('InvoiceIQ', session.login, secret), secret };
  });

  app.post<{ Body: { code?: string } }>('/auth/mfa/verify-setup', async (req, reply) => {
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ error: 'not authenticated' });
    const code = (req.body as { code?: string } | undefined)?.code;
    if (!code) return reply.code(400).send({ error: 'validation', detail: 'code is required' });
    const db = requirePool(reply);
    if (!db) return;
    const record = await getMfa(db, session.provider, session.externalId);
    if (!record) return reply.code(404).send({ error: 'not found', detail: 'no MFA setup in progress' });
    if (record.enabled) {
      return reply.code(409).send({ error: 'mfa_already_enabled', detail: 'two-factor authentication is already enabled' });
    }
    const secret = decryptTotpSecret(record.secretCiphertext, record.secretIv, record.secretTag, key);
    if (!verifyTotp(secret, code)) {
      return reply.code(401).send({ error: 'auth', detail: 'that code does not match' });
    }
    const recoveryCodes = await enableMfa(db, session.provider, session.externalId);
    return { ok: true, recoveryCodes };
  });

  app.post<{ Body: { code?: string; recoveryCode?: string } }>('/auth/mfa/disable', async (req, reply) => {
    const session = await currentSession(req);
    if (!session) return reply.code(401).send({ error: 'not authenticated' });
    const body = req.body as { code?: string; recoveryCode?: string } | undefined;
    const db = requirePool(reply);
    if (!db) return;
    const record = await getMfa(db, session.provider, session.externalId);
    if (!record) return reply.code(404).send({ error: 'not found', detail: 'two-factor authentication is not set up' });
    if (record.enabled) {
      let ok = false;
      if (body?.recoveryCode) {
        ok = await consumeRecoveryCode(db, session.provider, session.externalId, body.recoveryCode);
      } else if (body?.code) {
        const secret = decryptTotpSecret(record.secretCiphertext, record.secretIv, record.secretTag, key);
        ok = verifyTotp(secret, body.code);
      }
      if (!ok) return reply.code(401).send({ error: 'auth', detail: 'that code does not match' });
    }
    await disableMfa(db, session.provider, session.externalId);
    return { ok: true };
  });

  app.post<{ Body: { code?: string; recoveryCode?: string } }>('/auth/mfa/challenge', async (req, reply) => {
    const db = requirePool(reply);
    if (!db) return;
    const pendingToken = parseCookie(req.headers.cookie, MFA_PENDING_COOKIE);
    const pending = pendingToken ? verifyMfaPending(pendingToken, opts.sessionSecret) : undefined;
    if (!pending) {
      return reply.code(401).send({ error: 'mfa_required', detail: 'sign in again to continue' });
    }
    const body = req.body as { code?: string; recoveryCode?: string } | undefined;
    const record = await getMfa(db, pending.provider, pending.uid);
    if (record?.enabled) {
      let ok = false;
      if (body?.recoveryCode) {
        ok = await consumeRecoveryCode(db, pending.provider, pending.uid, body.recoveryCode);
      } else if (body?.code) {
        const secret = decryptTotpSecret(record.secretCiphertext, record.secretIv, record.secretTag, key);
        ok = verifyTotp(secret, body.code);
      }
      if (!ok) return reply.code(401).send({ error: 'auth', detail: 'that code does not match' });
    }
    const { token } = await createSession(
      db,
      {
        provider: pending.provider,
        externalId: pending.uid,
        login: pending.login,
        tenantId: pending.tid,
        roles: [...pending.roles],
        mfaVerified: true,
      },
      { userAgent: req.headers['user-agent'], ipHash: hashClientIp(req.ip) },
    );
    void reply.header('set-cookie', [sessionSetCookie(token, secure), mfaPendingClearCookie(secure)]);
    return { ok: true, login: pending.login };
  });
}
