-- Time-based one-time passwords (Auth v2). TOTP secrets are encrypted at
-- rest with a key derived from MFA_SECRET_KEY (falling back to
-- SESSION_SECRET); recovery codes are single-use SHA-256 hashes.
-- Owner-connection only, like the other auth tables.
CREATE TABLE IF NOT EXISTS user_mfa (
  provider           text NOT NULL,
  external_id        text NOT NULL,
  secret_ciphertext  text NOT NULL,
  secret_iv          text NOT NULL,
  secret_tag         text NOT NULL,
  enabled            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  external_id text NOT NULL,
  code_hash   text NOT NULL UNIQUE,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_identity ON recovery_codes (provider, external_id);

REVOKE ALL ON user_mfa FROM invoiceiq_app;
REVOKE ALL ON recovery_codes FROM invoiceiq_app;
