# Local development

Prerequisites: Node 22+, pnpm 10 (`corepack enable`), Python 3.11+, uv, make.
Docker is only needed for the local Postgres in `docker-compose.yml`.

```bash
make install   # pnpm install + uv sync
make check     # the single gate: lint, types, tests, drift checks
make contracts # regenerate TS, Zod and Pydantic from OpenAPI
make data      # regenerate synthetic labels and splits
docker compose up db   # optional: Postgres 16 on localhost:5432
```

`make check` must exit 0 from a clean checkout. If it does not, that is a bug.
