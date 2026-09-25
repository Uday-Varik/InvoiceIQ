# Local development

Prerequisites: Node 22+, pnpm 10 (`corepack enable`), Python 3.11+, uv, make.
Docker is needed for the local stack and for core-api's Postgres tests.

```bash
make install   # pnpm install + uv sync
make check     # the single gate: lint, types, tests, drift checks
make contracts # regenerate TS, Zod and Pydantic from OpenAPI
make data      # regenerate synthetic labels and splits
```

`make check` must exit 0 from a clean checkout. If it does not, that is a bug.

## Postgres integration tests

core-api's integration tests (`services/core-api/test/integration/`) run
against a real Postgres, never a mock. They create a throwaway database per
test file, owned by a non-superuser role, so row-level security behaves as it
does in production.

```bash
docker compose up db --detach --wait
make test-db        # or: TEST_DATABASE_URL=postgres://... make check
```

Without `TEST_DATABASE_URL` they are reported as skipped. CI sets
`REQUIRE_DB_TESTS=1`, which turns a missing database into a failure.

## The whole stack

```bash
make up                                   # db, ai-service, core-api in Docker
make smoke                                # upload -> extract -> approve -> verify audit
CORE_API_URL=http://localhost:3001 pnpm --filter @invoiceiq/web dev   # http://localhost:3000
```

core-api runs in `AUTH_MODE=demo` locally: no login, one demo tenant. Port
5432 taken? `DB_PORT=55432 make up` and `DB_PORT=55432 make test-db`.
