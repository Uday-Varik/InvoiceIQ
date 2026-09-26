# Postgres 16 on Neon (ADR-0008). The project's default role owns the schema and
# runs migrations; core-api's own migration creates invoiceiq_app, and boot
# gives it LOGIN with APP_DB_PASSWORD. The app role is deliberately NOT a
# neon_role resource: roles created through Neon's API join neon_superuser,
# which can bypass row-level security (ADR-0017).

resource "neon_project" "db" {
  name       = var.name_prefix
  pg_version = 16
  region_id  = var.neon_region

  # The free plan keeps six hours of history.
  history_retention_seconds = 21600

  branch {
    name          = "main"
    database_name = "invoiceiq"
    role_name     = "invoiceiq_owner"
  }
}

locals {
  db_name = neon_project.db.database_name

  # Owner, direct host: the migrator holds a session-level advisory lock, which
  # a transaction pooler would drop.
  migration_database_url = format(
    "postgres://%s:%s@%s/%s?sslmode=require",
    urlencode(neon_project.db.database_user),
    urlencode(neon_project.db.database_password),
    neon_project.db.database_host,
    local.db_name,
  )

  # App role, pooled host: tenant scoping is SET LOCAL per transaction, which is
  # safe under transaction pooling (ADR-0004).
  database_url = format(
    "postgres://invoiceiq_app:%s@%s/%s?sslmode=require",
    random_password.app_db.result,
    neon_project.db.database_host_pooler,
    local.db_name,
  )
}
