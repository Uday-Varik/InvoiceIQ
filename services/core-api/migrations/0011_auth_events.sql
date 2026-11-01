-- Authentication audit trail (Auth v2). One row per security-relevant
-- auth event: sign-ins, sign-outs, verification, resets, MFA changes,
-- membership changes, session revocations. Readable only through the
-- owner connection; the admin read endpoint filters by tenant.
-- Owner-connection only, like the other auth tables.
CREATE TABLE IF NOT EXISTS auth_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid,
  provider    text NOT NULL,
  external_id text NOT NULL,
  login       text NOT NULL,
  event       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_identity ON auth_events (provider, external_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_tenant ON auth_events (tenant_id, created_at DESC);

REVOKE ALL ON auth_events FROM invoiceiq_app;
