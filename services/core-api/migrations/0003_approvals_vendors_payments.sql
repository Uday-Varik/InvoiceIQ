-- 0003: Phase 3 controls: a vendor master with bank-change quarantine,
-- multi-person approvals with separation of duties, payment runs, and signed
-- audit checkpoints.
--
-- Same rules as 0001: runs as the schema owner, every new table has RLS enabled
-- AND forced on app_tenant(), and the app role only gets the grants below.

CREATE TABLE vendors (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  -- Lower-cased, punctuation-free and space-collapsed name used to link invoices.
  match_key text NOT NULL CHECK (length(match_key) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, match_key)
);

-- Every change to a vendor's remittance account. Only the last four characters
-- are kept: the full account lives in the payment system, not here.
CREATE TABLE vendor_bank_changes (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  account_last4 text NOT NULL CHECK (account_last4 ~ '^[0-9A-Z]{4}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  verified_by text,
  verified_at timestamptz,
  callback_note text CHECK (length(callback_note) BETWEEN 1 AND 2000),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors (tenant_id, id),
  -- Four-eyes at the storage layer too: nobody verifies their own change.
  CHECK (verified_by IS NULL OR verified_by <> requested_by),
  CHECK ((verified_by IS NULL) = (verified_at IS NULL) AND (verified_by IS NULL) = (callback_note IS NULL))
);
CREATE INDEX vendor_bank_changes_latest ON vendor_bank_changes (tenant_id, vendor_id, requested_at DESC);

CREATE TABLE payment_runs (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'paid', 'cancelled')),
  invoice_count integer NOT NULL CHECK (invoice_count >= 1),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  comment text CHECK (length(comment) <= 2000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by text,
  closed_at timestamptz,
  close_comment text CHECK (length(close_comment) <= 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  CHECK ((status = 'queued') = (closed_by IS NULL)),
  -- The person who assembled a run never confirms it was paid.
  CHECK (status <> 'paid' OR closed_by <> created_by)
);
CREATE INDEX payment_runs_tenant_created ON payment_runs (tenant_id, created_at DESC, id DESC);

-- What each run was asked to pay, frozen when the run was assembled: the
-- payment file is built from this snapshot, and confirming a run checks that
-- no vendor's account changed since.
CREATE TABLE payment_run_items (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  run_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  vendor_id uuid NOT NULL,
  account_last4 text CHECK (account_last4 ~ '^[0-9A-Z]{4}$'),
  bank_change_id uuid,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (tenant_id, run_id, invoice_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payment_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors (tenant_id, id)
);

ALTER TABLE invoices
  ADD COLUMN vendor_id uuid,
  -- The run currently paying the invoice; cleared when that run is cancelled.
  ADD COLUMN payment_run_id uuid,
  ADD FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, payment_run_id) REFERENCES payment_runs (tenant_id, id);
CREATE INDEX invoices_tenant_vendor ON invoices (tenant_id, vendor_id);
CREATE INDEX invoices_tenant_payment_run ON invoices (tenant_id, payment_run_id);

-- One row per approval given. An approval counts only while the invoice is
-- still at the version it was given for: any state change or correction bumps
-- the version, so earlier approvals stop counting.
CREATE TABLE invoice_approvals (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  invoice_version integer NOT NULL CHECK (invoice_version >= 1),
  approver_id text NOT NULL,
  approver_role text NOT NULL CHECK (approver_role IN ('ap_clerk', 'ap_manager', 'controller', 'cfo')),
  comment text CHECK (length(comment) <= 2000),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, invoice_id, invoice_version, approver_id)
);

-- Signed statements of the audit chain head. Published copies outside the
-- database are what make a rewrite detectable; this table is the local index.
CREATE TABLE audit_checkpoints (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  seq bigint NOT NULL CHECK (seq >= 0),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  public_key text NOT NULL,
  signature text NOT NULL,
  statement text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendors', 'vendor_bank_changes', 'payment_runs', 'payment_run_items', 'invoice_approvals', 'audit_checkpoints']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON vendors, vendor_bank_changes, payment_runs TO invoiceiq_app;
GRANT SELECT, INSERT ON payment_run_items, invoice_approvals, audit_checkpoints TO invoiceiq_app;
