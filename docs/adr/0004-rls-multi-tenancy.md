# ADR-0004: Multi-tenancy with Postgres row-level security

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Tenants are separate companies. A cross-tenant read leaks vendor bank details;
a cross-tenant write can redirect a payment. Application-level `WHERE
tenant_id = ?` filters fail open the first time someone forgets one.

## Decision

- Every tenant-owned table has a non-null `tenant_id` and **RLS enabled and
  forced** (`FORCE ROW LEVEL SECURITY`), with policies comparing against
  `current_setting('app.tenant_id')`.
- core-api sets `app.tenant_id` with `SET LOCAL` at the start of every
  transaction, from the verified JWT, never from request input.
- The application role is not the table owner and has no `BYPASSRLS`.
  Migrations run as a separate owner role.
- A Phase 1 test suite connects as the app role and asserts that reads and
  writes across tenants return zero rows or fail.

## Consequences

- A missing filter fails closed instead of leaking.
- Connection pooling must use transaction-scoped settings (`SET LOCAL`), which
  rules out session pooling for the app role.
- Cross-tenant admin reporting needs an explicit, audited role.

## Alternatives considered

- **Schema per tenant.** Rejected: migrations multiply with tenants and it
  complicates the shared queue (ADR-0003).
- **Database per tenant.** Rejected at this scale on cost (ADR-0008).
