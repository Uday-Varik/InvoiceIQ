import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ApproverRole } from './auth.js';
import { signSession, type SessionOptions } from './session.js';
import { findUserTenants, upsertTenantUser } from '../tenants/store.js';

export interface CredentialsAuthOptions extends SessionOptions {
  readonly frontendUrl?: string | undefined;
  readonly defaultRole: ApproverRole;
  readonly tenantId: string;
  readonly ownerPool?: Pool | undefined;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function registerCredentialsAuthRoutes(app: FastifyInstance, opts: CredentialsAuthOptions): void {
  const secure = process.env['NODE_ENV'] === 'production';
  const cookieOpts = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const sessionMaxAge = 7 * 24 * 60 * 60;

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
    if (password.length < 8) {
      return reply.code(400).send({ error: 'validation', detail: 'password must be at least 8 characters' });
    }

    if (!opts.ownerPool) {
      return reply.code(500).send({ error: 'config', detail: 'credentials auth requires database' });
    }

    const existing = await opts.ownerPool.query(
      'SELECT id FROM credential_users WHERE email = $1',
      [email],
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'conflict', detail: 'an account with this email already exists' });
    }

    const passwordHash = hashPassword(password);
    const userId = randomBytes(16).toString('hex');
    await opts.ownerPool.query(
      'INSERT INTO credential_users (id, email, password_hash) VALUES ($1, $2, $3)',
      [userId, email, passwordHash],
    );

    const membership = await upsertTenantUser(opts.ownerPool, {
      tenantId: opts.tenantId,
      provider: 'credentials',
      externalId: userId,
      login: email,
      roles: [opts.defaultRole],
    });

    const session = signSession(
      {
        uid: userId,
        login: email,
        tid: membership.tenantId,
        roles: [...membership.roles],
        provider: 'credentials',
        exp: Date.now() + sessionMaxAge * 1000,
      },
      opts.sessionSecret,
    );

    void reply.header('set-cookie', `iq_session=${session}; ${cookieOpts}; Max-Age=${sessionMaxAge}`);
    return { ok: true, login: email };
  });

  app.post<{ Body: { email?: string; password?: string } }>('/auth/credentials/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string } | undefined;
    const email = body?.email?.trim().toLowerCase();
    const password = body?.password;

    if (!email || !password) {
      return reply.code(400).send({ error: 'validation', detail: 'email and password are required' });
    }

    if (!opts.ownerPool) {
      return reply.code(500).send({ error: 'config', detail: 'credentials auth requires database' });
    }

    const result = await opts.ownerPool.query<{ id: string; email: string; password_hash: string }>(
      'SELECT id, email, password_hash FROM credential_users WHERE email = $1',
      [email],
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: 'auth', detail: 'invalid email or password' });
    }

    const memberships = await findUserTenants(opts.ownerPool, 'credentials', user.id);
    const first = memberships[0];

    let tid = opts.tenantId;
    let roles: readonly ApproverRole[] = [opts.defaultRole];

    if (first) {
      tid = first.tenantId;
      roles = first.roles;
    }

    const session = signSession(
      {
        uid: user.id,
        login: user.email,
        tid,
        roles: [...roles],
        provider: 'credentials',
        exp: Date.now() + sessionMaxAge * 1000,
      },
      opts.sessionSecret,
    );

    void reply.header('set-cookie', `iq_session=${session}; ${cookieOpts}; Max-Age=${sessionMaxAge}`);
    return { ok: true, login: user.email };
  });
}
