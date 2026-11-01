import type { Pool } from 'pg';

export type AuditDb = Pick<Pool, 'query'>;

export type AuthEvent =
  | 'login'
  | 'logout'
  | 'register'
  | 'email_verified'
  | 'password_reset'
  | 'password_changed'
  | 'mfa_setup'
  | 'mfa_disabled'
  | 'mfa_challenge'
  | 'member_added'
  | 'member_updated'
  | 'member_removed'
  | 'session_revoked'
  | 'tenant_switched';

export interface AuthEventInput {
  readonly tenantId?: string | undefined;
  readonly provider: string;
  readonly externalId: string;
  readonly login: string;
  readonly event: AuthEvent;
  readonly detail?: Record<string, unknown> | undefined;
  readonly ipHash?: string | undefined;
}

/**
 * Append one row to the auth audit trail. Callers await it: an auth event
 * that cannot be recorded is a failed request, not a silent gap. The
 * table is owner-only, so this must run against the owner pool.
 */
export async function recordAuthEvent(db: AuditDb, input: AuthEventInput): Promise<void> {
  await db.query(
    `INSERT INTO auth_events (tenant_id, provider, external_id, login, event, detail, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.tenantId ?? null,
      input.provider,
      input.externalId,
      input.login,
      input.event,
      JSON.stringify(input.detail ?? {}),
      input.ipHash ?? null,
    ],
  );
}

export interface AuthEventRow {
  readonly id: string;
  readonly tenantId: string | null;
  readonly provider: string;
  readonly externalId: string;
  readonly login: string;
  readonly event: string;
  readonly detail: Record<string, unknown>;
  readonly ipHash: string | null;
  readonly createdAt: string;
}

export async function listAuthEvents(
  db: AuditDb,
  tenantId: string,
  limit: number,
): Promise<AuthEventRow[]> {
  const { rows } = await db.query<{
    id: string;
    tenant_id: string | null;
    provider: string;
    external_id: string;
    login: string;
    event: string;
    detail: Record<string, unknown>;
    ip_hash: string | null;
    created_at: Date;
  }>(
    `SELECT * FROM auth_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    externalId: r.external_id,
    login: r.login,
    event: r.event,
    detail: r.detail,
    ipHash: r.ip_hash,
    createdAt: r.created_at.toISOString(),
  }));
}
