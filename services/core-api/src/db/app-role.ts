import pg from 'pg';

export const APP_ROLE = 'invoiceiq_app';

/**
 * Give the application role LOGIN and a password, as the owner. Migration 0001
 * creates invoiceiq_app without login; on a fresh hosted database this replaces
 * the hand-run ALTER ROLE step, so Terraform can hand core-api a generated
 * password and a DATABASE_URL that uses it. Idempotent: runs on every boot and
 * also rotates the password when the setting changes.
 *
 * The role is created by our migration, never by the hosting provider's API:
 * provider-created roles can join admin groups (on Neon, neon_superuser, which
 * has BYPASSRLS), and a role that can SET ROLE into one could read every tenant.
 */
export async function setAppRolePassword(ownerConnectionString: string, password: string, role: string = APP_ROLE): Promise<void> {
  if (password.length < 24) throw new Error('app role password must be at least 24 characters');
  const client = new pg.Client({ connectionString: ownerConnectionString });
  await client.connect();
  try {
    // RLS is the tenant boundary; refuse to hand out a login for a role that ignores it.
    const found = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role]);
    const attrs = found.rows[0];
    if (!attrs) throw new Error(`role ${role} does not exist; run the migrations first`);
    if (attrs.rolsuper || attrs.rolbypassrls) throw new Error(`role ${role} bypasses row-level security; refusing to enable its login`);
    // format(%L) quotes the literal server-side; ALTER ROLE takes no bind parameters.
    // Only LOGIN and PASSWORD: a non-superuser owner (as on Neon) may not touch other attributes.
    const { rows } = await client.query<{ sql: string }>(`SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql`, [
      role,
      password,
    ]);
    await client.query((rows[0] as { sql: string }).sql);
  } finally {
    await client.end();
  }
}
