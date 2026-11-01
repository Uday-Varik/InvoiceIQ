import type { Pool } from 'pg';
import type { ApproverRole } from '../domain/index.js';

export interface TenantUser {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly login: string;
  readonly roles: readonly ApproverRole[];
  readonly isOwner: boolean;
  readonly lastUsedAt: string;
  readonly createdAt: string;
}

export interface TenantUserRow {
  id: string;
  tenant_id: string;
  provider: string;
  external_id: string;
  login: string;
  roles: string[];
  is_owner: boolean;
  last_used_at: Date;
  created_at: Date;
}

function toTenantUser(r: TenantUserRow): TenantUser {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    externalId: r.external_id,
    login: r.login,
    roles: r.roles as ApproverRole[],
    isOwner: r.is_owner,
    lastUsedAt: r.last_used_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  };
}

/** Find all tenant memberships for an external identity (bypasses RLS — uses owner pool). */
export async function findUserTenants(
  db: Pool,
  provider: string,
  externalId: string,
): Promise<TenantUser[]> {
  const { rows } = await db.query<TenantUserRow>(
    `SELECT * FROM tenant_users WHERE provider = $1 AND external_id = $2 ORDER BY last_used_at DESC`,
    [provider, externalId],
  );
  return rows.map(toTenantUser);
}

/** Upsert a user into a tenant. Returns the membership. */
export async function upsertTenantUser(
  db: Pool,
  input: {
    tenantId: string;
    provider: string;
    externalId: string;
    login: string;
    roles?: readonly ApproverRole[];
    isOwner?: boolean;
  },
): Promise<TenantUser> {
  const roles = input.roles ?? ['ap_clerk'];
  const isOwner = input.isOwner ?? false;
  const { rows } = await db.query<TenantUserRow>(
    `INSERT INTO tenant_users (tenant_id, provider, external_id, login, roles, is_owner)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider, external_id, tenant_id)
     DO UPDATE SET login = EXCLUDED.login, last_used_at = now()
     RETURNING *`,
    [input.tenantId, input.provider, input.externalId, input.login, roles, isOwner],
  );
  const row = rows[0];
  if (!row) throw new Error('upsert returned no row');
  return toTenantUser(row);
}

/** Touch last_used_at for the membership. */
export async function touchTenantUser(db: Pool, provider: string, externalId: string, tenantId: string): Promise<void> {
  await db.query(
    `UPDATE tenant_users SET last_used_at = now() WHERE provider = $1 AND external_id = $2 AND tenant_id = $3`,
    [provider, externalId, tenantId],
  );
}

/** One identity's membership in one tenant, if it exists. */
export async function findMembership(
  db: Pool,
  provider: string,
  externalId: string,
  tenantId: string,
): Promise<TenantUser | undefined> {
  const { rows } = await db.query<TenantUserRow>(
    `SELECT * FROM tenant_users WHERE provider = $1 AND external_id = $2 AND tenant_id = $3`,
    [provider, externalId, tenantId],
  );
  const row = rows[0];
  return row ? toTenantUser(row) : undefined;
}

/** Update a membership's roles and/or owner flag. Returns the updated membership, or undefined when absent. */
export async function updateTenantUser(
  db: Pool,
  tenantId: string,
  userId: string,
  patch: { roles?: readonly ApproverRole[]; isOwner?: boolean },
): Promise<TenantUser | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.roles !== undefined) {
    params.push(patch.roles);
    sets.push(`roles = $${params.length}`);
  }
  if (patch.isOwner !== undefined) {
    params.push(patch.isOwner);
    sets.push(`is_owner = $${params.length}`);
  }
  if (sets.length === 0) return undefined;
  params.push(tenantId, userId);
  const { rows } = await db.query<TenantUserRow>(
    `UPDATE tenant_users SET ${sets.join(', ')}, last_used_at = now() WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING *`,
    params,
  );
  const row = rows[0];
  return row ? toTenantUser(row) : undefined;
}

/**
 * Membership-change guardrails, as pure decisions over the current
 * member list so they can be tested without a database:
 * - a tenant must always keep at least one owner;
 * - nobody may remove or demote the last owner, including themself;
 * - nobody may strip their own last role or owner flag and lock
 *   themselves out of managing the tenant.
 * Returns an error message when the change is forbidden, else undefined.
 */
export function checkMemberChange(
  members: readonly TenantUser[],
  change: {
    readonly targetId: string;
    readonly callerId: string;
    readonly nextRoles?: readonly ApproverRole[] | undefined;
    readonly nextIsOwner?: boolean | undefined;
    readonly remove?: boolean | undefined;
  },
): string | undefined {
  const target = members.find((m) => m.id === change.targetId);
  if (!target) return 'member not found';
  const owners = members.filter((m) => m.isOwner);
  const lastOwner = owners.length === 1 && owners[0]?.id === target.id;
  if (change.remove === true) {
    if (lastOwner) return 'a tenant must keep at least one owner';
    return undefined;
  }
  if (change.nextIsOwner === false && lastOwner) {
    return 'a tenant must keep at least one owner';
  }
  if (change.targetId === change.callerId) {
    if (change.nextRoles !== undefined && change.nextRoles.length === 0) {
      return 'you cannot remove all of your own roles';
    }
    if (change.nextIsOwner === false && target.isOwner && owners.length === 1) {
      return 'a tenant must keep at least one owner';
    }
  }
  return undefined;
}

/** List users in a tenant (bypasses RLS — uses owner pool). */
export async function listTenantUsers(db: Pool, tenantId: string): Promise<TenantUser[]> {
  const { rows } = await db.query<TenantUserRow>(
    `SELECT * FROM tenant_users WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows.map(toTenantUser);
}

/** Remove a user from a tenant. */
export async function removeTenantUser(db: Pool, tenantId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM tenant_users WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId],
  );
  return (rowCount ?? 0) > 0;
}
