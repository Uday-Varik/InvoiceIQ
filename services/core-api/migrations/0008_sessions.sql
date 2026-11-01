-- Server-side sessions (Auth v2). The session cookie holds only an opaque
-- random token; the token's SHA-256 hash is stored here, so a leaked
-- database dump does not yield usable sessions, and any session can be
-- revoked individually or all at once. Accessed only via the owner
-- connection, never through row-level-security app queries.
CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  provider     text NOT NULL,
  external_id  text NOT NULL,
  login        text NOT NULL,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  roles        text[] NOT NULL DEFAULT '{ap_clerk}',
  mfa_verified boolean NOT NULL DEFAULT false,
  user_agent   text,
  ip_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions (provider, external_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at) WHERE revoked_at IS NULL;

REVOKE ALL ON sessions FROM invoiceiq_app;
