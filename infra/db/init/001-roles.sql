-- Local-only bootstrap. Creates the non-owner application role that RLS applies
-- to (ADR-0004) with a local password. Schema, grants and policies come from
-- services/core-api/migrations, which core-api applies on boot.
CREATE ROLE invoiceiq_app LOGIN PASSWORD 'invoiceiq-local-only' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE invoiceiq TO invoiceiq_app;
