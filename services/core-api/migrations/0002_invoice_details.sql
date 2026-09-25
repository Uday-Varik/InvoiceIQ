-- 0002: invoice details for Phase 2: subtotal, tax, due date, line items and
-- reviewer corrections, plus indexes for the dashboard filters.
--
-- Same rules as 0001: runs as the schema owner, the new table has RLS enabled
-- AND forced on app_tenant(), and the app role only gets the grants below.

ALTER TABLE invoices
  ADD COLUMN due_date date,
  ADD COLUMN subtotal_minor bigint,
  ADD COLUMN tax_minor bigint,
  -- Fields a human has corrected since extraction (CorrectableField names).
  ADD COLUMN corrected_fields text[] NOT NULL DEFAULT '{}';

CREATE TABLE invoice_line_items (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  quantity numeric(16, 4) CHECK (quantity >= 0),
  unit_price_minor bigint,
  amount_minor bigint,
  PRIMARY KEY (tenant_id, invoice_id, position)
);

ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_line_items
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- A correction replaces the lines of one invoice, so the app may delete them.
-- The audit ledger keeps the before and after of every correction.
GRANT SELECT, INSERT, DELETE ON invoice_line_items TO invoiceiq_app;

-- Dashboard filters: state tabs, invoice-date ranges and per-currency totals.
CREATE INDEX invoices_tenant_state_created ON invoices (tenant_id, state, created_at DESC, id DESC);
CREATE INDEX invoices_tenant_invoice_date ON invoices (tenant_id, invoice_date);
CREATE INDEX invoices_tenant_currency_total ON invoices (tenant_id, currency, total_minor);
