-- 0001: tenants, invoices, documents, audit ledger, idempotency keys and the outbox.
--
-- Runs as the schema owner (MIGRATION_DATABASE_URL). The application connects as
-- invoiceiq_app, which is not the owner, has no BYPASSRLS, and only gets the
-- grants below (ADR-0004). Every tenant-owned table has RLS enabled AND forced,
-- keyed on app_tenant(), which core-api sets with SET LOCAL per transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoiceiq_app') THEN
    -- Created without LOGIN: an operator enables login and sets the password out of band.
    CREATE ROLE invoiceiq_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- NULL (and so no rows) when the transaction has not set a tenant: fail closed.
CREATE FUNCTION app_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  policy jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  state text NOT NULL CHECK (state IN (
    'RECEIVED', 'EXTRACTING', 'EXTRACTED', 'VALIDATING', 'VALIDATED', 'MATCHING', 'MATCHED',
    'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'HOLD', 'EXCEPTION', 'PAYMENT_QUEUED', 'PAID'
  )),
  reasons text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  source_channel text NOT NULL CHECK (source_channel IN ('upload', 'email', 'api')),
  document_sha256 text NOT NULL,
  document_filename text NOT NULL CHECK (length(document_filename) BETWEEN 1 AND 255),
  vendor_name text CHECK (length(vendor_name) <= 256),
  invoice_number text CHECK (length(invoice_number) <= 64),
  invoice_date date,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint,
  extraction jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_sha256),
  FOREIGN KEY (tenant_id, document_sha256) REFERENCES documents (tenant_id, sha256)
);
CREATE INDEX invoices_tenant_created ON invoices (tenant_id, created_at DESC, id DESC);

CREATE TABLE audit_log (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  seq bigint NOT NULL CHECK (seq >= 0),
  invoice_id uuid NOT NULL,
  type text NOT NULL,
  actor jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX audit_log_invoice ON audit_log (tenant_id, invoice_id, seq);

-- Append-only even for the owner (ADR-0009). The app role has no UPDATE/DELETE grant either.
CREATE FUNCTION audit_log_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  key text NOT NULL CHECK (length(key) BETWEEN 16 AND 128),
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Transactional outbox (ADR-0003): written in the same transaction as the state
-- change it announces, drained by core-api's in-process worker.
CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  event_id uuid NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  processed_at timestamptz,
  dead_at timestamptz,
  last_error text,
  UNIQUE (tenant_id, event_id)
);
CREATE INDEX outbox_pending ON outbox (available_at, id) WHERE processed_at IS NULL AND dead_at IS NULL;

-- Row-level security on every tenant-owned table.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant()) WITH CHECK (id = app_tenant());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_policies', 'documents', 'invoices', 'audit_log', 'idempotency_keys', 'outbox']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t
    );
  END LOOP;
END
$$;

-- The relay must see pending rows of every tenant to claim them. Only the owner
-- role gets that policy, and the app role reaches it solely through
-- claim_outbox(), which returns ids and payloads and changes nothing else.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY outbox_relay ON outbox TO %I USING (true) WITH CHECK (true)', current_user);
END
$$;

CREATE FUNCTION claim_outbox(batch integer, lease_seconds integer)
  RETURNS TABLE (id bigint, tenant_id uuid, event_id uuid, topic text, payload jsonb, attempts integer)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE outbox o
       SET locked_until = now() + make_interval(secs => lease_seconds),
           attempts = o.attempts + 1
     WHERE o.id IN (
       SELECT p.id FROM outbox p
        WHERE p.processed_at IS NULL
          AND p.dead_at IS NULL
          AND p.available_at <= now()
          AND (p.locked_until IS NULL OR p.locked_until < now())
        ORDER BY p.available_at, p.id
        LIMIT least(batch, 100)
        FOR UPDATE SKIP LOCKED
     )
    RETURNING o.id, o.tenant_id, o.event_id, o.topic, o.payload, o.attempts
  $$;
REVOKE ALL ON FUNCTION claim_outbox(integer, integer) FROM PUBLIC;

-- Grants: least privilege for the application role.
GRANT USAGE ON SCHEMA public TO invoiceiq_app;
GRANT EXECUTE ON FUNCTION app_tenant() TO invoiceiq_app;
GRANT EXECUTE ON FUNCTION claim_outbox(integer, integer) TO invoiceiq_app;
GRANT SELECT ON tenants, tenant_policies TO invoiceiq_app;
GRANT SELECT, INSERT ON documents, audit_log TO invoiceiq_app;
GRANT SELECT, INSERT, UPDATE ON invoices, idempotency_keys, outbox TO invoiceiq_app;
