-- Local email/password accounts for credential-based authentication.
CREATE TABLE IF NOT EXISTS credential_users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credential_users_email ON credential_users (email);

-- Not tenant-scoped; accessed only via the owner connection.
REVOKE ALL ON credential_users FROM invoiceiq_app;
