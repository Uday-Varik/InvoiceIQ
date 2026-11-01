-- Account lifecycle for email/password accounts (Auth v2): email
-- verification, password reset, and brute-force lockout. Accounts created
-- before verification existed are grandfathered verified: verification
-- did not exist when they were created, and every one of them can still
-- re-verify through the resend endpoint if ever needed.
ALTER TABLE credential_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

UPDATE credential_users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- Single-use, hashed, expiring tokens. The raw token is emailed (or
-- logged by the log mailer); only its SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL REFERENCES credential_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL REFERENCES credential_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (user_id);

-- Not tenant-scoped; accessed only via the owner connection.
REVOKE ALL ON email_verification_tokens FROM invoiceiq_app;
REVOKE ALL ON password_reset_tokens FROM invoiceiq_app;
