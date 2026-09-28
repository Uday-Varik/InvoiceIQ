-- Maps external identity provider users to tenants.
-- A user may belong to multiple tenants; the most-recently-used is their default.
CREATE TABLE IF NOT EXISTS tenant_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  provider    text NOT NULL DEFAULT 'github',
  external_id text NOT NULL,
  login       text NOT NULL,
  roles       text[] NOT NULL DEFAULT '{ap_clerk}',
  is_owner    boolean NOT NULL DEFAULT false,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, external_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_ext ON tenant_users (provider, external_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users (tenant_id);

ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_users_isolation ON tenant_users
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
