import pg from 'pg';

/** Create the cluster-wide roles once, before test files run in parallel. */
export default async function setup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) return;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoiceiq_owner') THEN
          CREATE ROLE invoiceiq_owner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD 'invoiceiq-test-only';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoiceiq_app') THEN
          CREATE ROLE invoiceiq_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'invoiceiq-test-only';
        END IF;
      END $$`);
  } finally {
    await c.end();
  }
}
