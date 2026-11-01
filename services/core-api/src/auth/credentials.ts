import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { ApproverRole } from './auth.js';
import {
  createSession,
  hashClientIp,
  readSessionToken,
  revokeAllSessions,
  sessionSetCookie,
  verifySessionToken,
  type SessionOptions,
} from './session.js';
import { findUserTenants, upsertTenantUser } from '../tenants/store.js';
import {
  hashAccountToken,
  isLocked,
  lockRetryAfterSeconds,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  newAccountToken,
  passwordError,
  RESET_TOKEN_HOURS,
  tokenExpiry,
  VERIFICATION_TOKEN_HOURS,
} from './tokens.js';
import { logMailer, resetLink, verificationLink, type Mailer } from './mailer.js';
import { isMfaEnabled } from './mfa.js';
import { mfaPendingSetCookie, signMfaPending } from './tokens.js';

export interface CredentialsAuthOptions extends SessionOptions {
  readonly frontendUrl?: string | undefined;
  readonly defaultRole: ApproverRole;
  readonly tenantId: string;
  readonly ownerPool?: Pool | undefined;
  readonly mailer?: Mailer | undefined;
  /** Frontend origin, for the links emailed to users. */
  readonly appBaseUrl?: string | undefined;
}

/** scrypt parameters, explicit so a future change is a decision, not drift. */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64, SCRYPT_OPTIONS);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** A fixed dummy hash, so unknown emails cost the same scrypt work as real ones. */
const DUMMY_HASH = (() => {
  const salt = '00'.repeat(16);
  return `${salt}:${scryptSync('dummy-password-that-never-matches', salt, 64, SCRYPT_OPTIONS).toString('hex')}`;
})();

interface CredentialUserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
}

export function registerCredentialsAuthRoutes(app: FastifyInstance, opts: CredentialsAuthOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';
  const mailer = opts.mailer ?? logMailer({ from: 'no-reply@invoiceiq.local' });
  const pool = opts.ownerPool;

  function requirePool(reply: FastifyReply): Pool | undefined {
    if (!pool) {
      void reply.code(500).send({ error: 'config', detail: 'credentials auth requires database' });
      return undefined;
    }
    return pool;
  }

  async function issueVerificationToken(db: Pool, userId: string, email: string): Promise<void> {
    const token = newAccountToken();
    await db.query(
      'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [userId, hashAccountToken(token), tokenExpiry(VERIFICATION_TOKEN_HOURS)],
    );
    await mailer.sendVerificationEmail(email, verificationLink(opts.appBaseUrl ?? opts.frontendUrl, token));
  }

  app.post<{ Body: { email?: string; password?: string } }>('/auth/credentials/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string } | undefined;
    const email = body?.email?.trim().toLowerCase();
    const password = body?.password;

    if (!email || !password) {
      return reply.code(400).send({ error: 'validation', detail: 'email and password are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'validation', detail: 'invalid email format' });
    }
    const pwError = passwordError(password);
    if (pwError) {
      return reply.code(400).send({ error: 'validation', detail: pwError });
    }

    const db = requirePool(reply);
    if (!db) return;

    const existing = await db.query<CredentialUserRow>('SELECT * FROM credential_users WHERE email = $1', [email]);
    const prior = existing.rows[0];
    if (prior) {
      if (prior.email_verified_at) {
        return reply.code(409).send({ error: 'conflict', detail: 'an account with this email already exists' });
      }
      // Unverified re-registration just resends the verification email;
      // the password is left untouched so a stranger cannot reset it here.
      await issueVerificationToken(db, prior.id, prior.email);
      return { ok: true, verificationRequired: true, login: prior.email };
    }

    const passwordHash = hashPassword(password);
    const userId = randomBytes(16).toString('hex');
    await db.query('INSERT INTO credential_users (id, email, password_hash) VALUES ($1, $2, $3)', [
      userId,
      email,
      passwordHash,
    ]);

    await upsertTenantUser(db, {
      tenantId: opts.tenantId,
      provider: 'credentials',
      externalId: userId,
      login: email,
      roles: [opts.defaultRole],
    });

    await issueVerificationToken(db, userId, email);
    return { ok: true, verificationRequired: true, login: email };
  });

  app.post<{ Body: { email?: string; password?: string } }>('/auth/credentials/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string } | undefined;
    const email = body?.email?.trim().toLowerCase();
    const password = body?.password;

    if (!email || !password) {
      return reply.code(400).send({ error: 'validation', detail: 'email and password are required' });
    }

    const db = requirePool(reply);
    if (!db) return;

    const result = await db.query<CredentialUserRow>('SELECT * FROM credential_users WHERE email = $1', [email]);
    const user = result.rows[0];
    // Verify against a dummy hash for unknown emails: same work, same
    // response shape, no account-enumeration timing signal.
    const passwordOk = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !passwordOk) {
      if (user) {
        const attempts = user.failed_attempts + 1;
        if (attempts >= MAX_FAILED_ATTEMPTS) {
          await db.query(
            'UPDATE credential_users SET failed_attempts = 0, locked_until = $2 WHERE id = $1',
            [user.id, new Date(Date.now() + LOCKOUT_MS)],
          );
        } else {
          await db.query('UPDATE credential_users SET failed_attempts = $2 WHERE id = $1', [user.id, attempts]);
        }
      }
      return reply.code(401).send({ error: 'auth', detail: 'invalid email or password' });
    }

    if (isLocked(user.locked_until)) {
      return reply.code(403).send({
        error: 'account_locked',
        detail: 'account locked after too many failed sign-in attempts',
        retryAfterSeconds: lockRetryAfterSeconds(user.locked_until),
      });
    }

    if (!user.email_verified_at) {
      return reply.code(403).send({
        error: 'email_not_verified',
        detail: 'verify your email address before signing in',
      });
    }

    await db.query('UPDATE credential_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

    const memberships = await findUserTenants(db, 'credentials', user.id);
    const first = memberships[0];
    const tid = first?.tenantId ?? opts.tenantId;
    const roles: readonly ApproverRole[] = first?.roles ?? [opts.defaultRole];

    if (await isMfaEnabled(db, 'credentials', user.id)) {
      const pending = signMfaPending(
        { uid: user.id, provider: 'credentials', login: user.email, tid, roles: [...roles] },
        opts.sessionSecret,
      );
      void reply.header('set-cookie', mfaPendingSetCookie(pending, secure));
      return { ok: true, mfaRequired: true, login: user.email };
    }

    const { token } = await createSession(
      db,
      {
        provider: 'credentials',
        externalId: user.id,
        login: user.email,
        tenantId: tid,
        roles: [...roles],
      },
      { userAgent: req.headers['user-agent'], ipHash: hashClientIp(req.ip) },
    );

    void reply.header('set-cookie', sessionSetCookie(token, secure));
    return { ok: true, login: user.email };
  });

  app.post<{ Body: { token?: string } }>('/auth/credentials/verify-email', async (req, reply) => {
    const token = (req.body as { token?: string } | undefined)?.token;
    if (!token) return reply.code(400).send({ error: 'validation', detail: 'token is required' });
    const db = requirePool(reply);
    if (!db) return;
    const found = await db.query<{ user_id: string }>(
      'SELECT user_id FROM email_verification_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [hashAccountToken(token)],
    );
    const row = found.rows[0];
    if (!row) return reply.code(400).send({ error: 'invalid_token', detail: 'verification link is invalid or expired' });
    await db.query('UPDATE credential_users SET email_verified_at = now() WHERE id = $1', [row.user_id]);
    await db.query('UPDATE email_verification_tokens SET used_at = now() WHERE token_hash = $1', [hashAccountToken(token)]);
    return { ok: true };
  });

  app.post<{ Body: { email?: string } }>('/auth/credentials/resend-verification', async (req, reply) => {
    const email = (req.body as { email?: string } | undefined)?.email?.trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'validation', detail: 'email is required' });
    const db = requirePool(reply);
    if (!db) return;
    // Always 200: whether the address exists or is already verified is
    // not something a stranger should learn from this endpoint.
    const found = await db.query<CredentialUserRow>('SELECT * FROM credential_users WHERE email = $1', [email]);
    const user = found.rows[0];
    if (user && !user.email_verified_at) {
      await issueVerificationToken(db, user.id, user.email);
    }
    return { ok: true };
  });

  app.post<{ Body: { email?: string } }>('/auth/credentials/forgot-password', async (req, reply) => {
    const email = (req.body as { email?: string } | undefined)?.email?.trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'validation', detail: 'email is required' });
    const db = requirePool(reply);
    if (!db) return;
    // Always 200, same reason as resend-verification.
    const found = await db.query<CredentialUserRow>('SELECT id, email FROM credential_users WHERE email = $1', [email]);
    const user = found.rows[0];
    if (user) {
      const token = newAccountToken();
      await db.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, hashAccountToken(token), tokenExpiry(RESET_TOKEN_HOURS)],
      );
      await mailer.sendPasswordResetEmail(user.email, resetLink(opts.appBaseUrl ?? opts.frontendUrl, token));
    }
    return { ok: true };
  });

  app.post<{ Body: { token?: string; password?: string } }>('/auth/credentials/reset-password', async (req, reply) => {
    const body = req.body as { token?: string; password?: string } | undefined;
    const token = body?.token;
    const password = body?.password;
    if (!token || !password) {
      return reply.code(400).send({ error: 'validation', detail: 'token and password are required' });
    }
    const pwError = passwordError(password);
    if (pwError) {
      return reply.code(400).send({ error: 'validation', detail: pwError });
    }
    const db = requirePool(reply);
    if (!db) return;
    const found = await db.query<{ user_id: string }>(
      'SELECT user_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [hashAccountToken(token)],
    );
    const row = found.rows[0];
    if (!row) return reply.code(400).send({ error: 'invalid_token', detail: 'reset link is invalid or expired' });
    await db.query(
      'UPDATE credential_users SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [row.user_id, hashPassword(password)],
    );
    await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1', [hashAccountToken(token)]);
    // A reset ends every session: whoever holds the old password, or a
    // stolen session, is signed out everywhere.
    await revokeAllSessions(db, 'credentials', row.user_id);
    return { ok: true };
  });

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/auth/credentials/change-password',
    async (req, reply) => {
      const body = req.body as { currentPassword?: string; newPassword?: string } | undefined;
      const currentPassword = body?.currentPassword;
      const newPassword = body?.newPassword;
      if (!currentPassword || !newPassword) {
        return reply.code(400).send({ error: 'validation', detail: 'current and new passwords are required' });
      }
      const pwError = passwordError(newPassword);
      if (pwError) {
        return reply.code(400).send({ error: 'validation', detail: pwError });
      }
      const db = requirePool(reply);
      if (!db) return;
      const rawCookie = req.headers.cookie;
      const token = readSessionToken(typeof rawCookie === 'string' ? rawCookie : undefined);
      const session = token ? await verifySessionToken(db, token) : undefined;
      if (!session || session.provider !== 'credentials') {
        return reply.code(401).send({ error: 'not authenticated' });
      }
      const found = await db.query<CredentialUserRow>('SELECT * FROM credential_users WHERE id = $1', [session.externalId]);
      const user = found.rows[0];
      if (!user || !verifyPassword(currentPassword, user.password_hash)) {
        return reply.code(401).send({ error: 'auth', detail: 'current password is incorrect' });
      }
      await db.query('UPDATE credential_users SET password_hash = $2 WHERE id = $1', [user.id, hashPassword(newPassword)]);
      // Keep this session, end every other one.
      await revokeAllSessions(db, 'credentials', user.id, session.id);
      return { ok: true };
    },
  );
}
