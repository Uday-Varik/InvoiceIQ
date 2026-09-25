-- Local-only bootstrap. Creates the non-owner application role that RLS applies
-- to (ADR-0004). Schema and policies arrive with Phase 1 migrations.
CREATE ROLE invoiceiq_app LOGIN PASSWORD 'invoiceiq-local-only' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE invoiceiq TO invoiceiq_app;
