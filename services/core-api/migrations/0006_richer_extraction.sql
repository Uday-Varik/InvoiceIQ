-- 0006: Richer extraction fields (Phase 14): payment terms, PO number,
-- vendor address and vendor tax ID.

ALTER TABLE invoices
  ADD COLUMN payment_terms text CHECK (length(payment_terms) <= 100),
  ADD COLUMN po_number text CHECK (length(po_number) <= 64),
  ADD COLUMN vendor_address text CHECK (length(vendor_address) <= 500),
  ADD COLUMN vendor_tax_id text CHECK (length(vendor_tax_id) <= 64);
