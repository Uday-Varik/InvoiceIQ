import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

/**
 * Integration tests run against a real Postgres. TEST_DATABASE_URL must point
 * at a superuser connection (docker compose `db`, or the CI service). Each test
 * file gets a fresh database owned by a non-superuser owner role, so RLS
 * behaves exactly as in production (superusers bypass it).
 */
export const ADMIN_URL = process.env['TEST_DATABASE_URL'];
export const ROLE_PASSWORD = 'invoiceiq-test-only';

if (!ADMIN_URL && process.env['REQUIRE_DB_TESTS'] === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set');
}

/** `describe` that skips (visibly) when no database is configured. */
export const describeDb = ADMIN_URL ? describe : describe.skip;

function withCredentials(url: string, user: string, database: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = ROLE_PASSWORD;
  u.pathname = `/${database}`;
  return u.toString();
}

export interface TestDatabase {
  readonly name: string;
  readonly ownerUrl: string;
  readonly appUrl: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!ADMIN_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `iq_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER invoiceiq_owner`);
  } finally {
    await admin.end();
  }
  const ownerUrl = withCredentials(ADMIN_URL, 'invoiceiq_owner', name);
  await migrate(ownerUrl);
  return {
    name,
    ownerUrl,
    appUrl: withCredentials(ADMIN_URL, 'invoiceiq_app', name),
    async drop() {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
