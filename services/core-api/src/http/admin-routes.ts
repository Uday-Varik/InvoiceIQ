/**
 * Phase 11 admin routes: tenant provisioning and management.
 *
 * These routes run as the owner role (MIGRATION_DATABASE_URL) because tenant
 * creation is an operator action that bypasses RLS. In production, gate them
 * behind a platform-admin check or an internal network boundary.
 *
 * Not yet wired into app.ts — listed here at x-phase: 11 so the contract
 * leads code and the bootstrap logic is reusable from the CLI or a future
 * admin UI.
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bootstrapTenant, defaultPolicy } from '../db/bootstrap.js';
import type { PolicyInput } from '../domain/index.js';

export interface TenantCreateInput {
  readonly name: string;
  readonly baseCurrency?: string;
}

export interface TenantRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export async function createTenantRecord(
  ownerConnectionString: string,
  input: TenantCreateInput,
): Promise<TenantRecord> {
  const id = randomUUID();
  const policy: PolicyInput = {
    ...defaultPolicy(id),
    baseCurrency: input.baseCurrency ?? 'USD',
  };
  await bootstrapTenant(ownerConnectionString, { id, name: input.name, policy });
  const client = new pg.Client({ connectionString: ownerConnectionString });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT id, name, created_at FROM tenants WHERE id = $1',
      [id],
    );
    const row = res.rows[0];
    return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
  } finally {
    await client.end();
  }
}

export async function listTenants(
  ownerConnectionString: string,
  limit = 50,
): Promise<TenantRecord[]> {
  const client = new pg.Client({ connectionString: ownerConnectionString });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT id, name, created_at FROM tenants ORDER BY created_at DESC LIMIT $1',
      [Math.min(limit, 200)],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
    }));
  } finally {
    await client.end();
  }
}

export async function getTenant(
  ownerConnectionString: string,
  tenantId: string,
): Promise<TenantRecord | null> {
  const client = new pg.Client({ connectionString: ownerConnectionString });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT id, name, created_at FROM tenants WHERE id = $1',
      [tenantId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
  } finally {
    await client.end();
  }
}
