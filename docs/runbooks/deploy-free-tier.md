# Deploying the public demo on free tiers

> **Written-unverified (W-UNV).** The steps below have not been run against
> real Neon, Render or Vercel accounts. The images they deploy are built and
> smoke-tested in CI (`docker` job), and the same stack runs locally with
> `make up && make smoke`.

| Piece | Host | Config |
| --- | --- | --- |
| Postgres 16 | Neon (free) | two connection strings |
| core-api, ai-service | Render (free web services, Docker) | [`render.yaml`](../../render.yaml) |
| apps/web | Vercel (Hobby) | [`apps/web/vercel.json`](../../apps/web/vercel.json) |

## 1. Neon

1. Create a project with Postgres 16. The default role (for example
   `neondb_owner`) owns the schema and runs migrations.
2. Run the first migration once, or let core-api do it on boot (step 2). It
   creates `invoiceiq_app` **without login**. Give it a password in the SQL
   editor:

   ```sql
   ALTER ROLE invoiceiq_app WITH LOGIN PASSWORD '<generate one>';
   ```

3. Copy two URLs:
   - `MIGRATION_DATABASE_URL`: owner role, **direct** (unpooled) host. The
     migrator takes a session-level advisory lock, which a transaction pooler
     would drop.
   - `DATABASE_URL`: `invoiceiq_app`, **pooled** host. core-api sets the
     tenant with `set_config(..., true)` inside each transaction, which is
     safe under transaction pooling (ADR-0004).

   Both need `?sslmode=require`.

## 2. Render

1. New, then Blueprint, then pick this repo. Render reads `render.yaml` and
   creates both services plus the `invoiceiq-shared` group with a generated
   `AI_SIGNING_SECRET`.
2. Fill in the `sync: false` values on `invoiceiq-core-api`: the two Neon URLs
   and `AI_SERVICE_URL` (the ai-service's `https://…onrender.com` URL).
3. Deploy. core-api migrates, bootstraps the demo tenant and starts draining
   the outbox. Check `https://<core-api>/healthz`.
4. Smoke it: `scripts/smoke.sh https://<core-api>.onrender.com`.

## 3. Vercel

1. Import the repo, set **Root Directory** to `apps/web`, keep "Include files
   outside the root directory" on (pnpm workspace).
2. Set `CORE_API_URL=https://<core-api>.onrender.com` for Production and
   Preview. The browser never calls core-api directly: `/api/core/*` is
   rewritten to it, so there is no CORS to configure.

## Cold starts

Render's free services sleep after about 15 minutes idle and take roughly a
minute to wake. The design absorbs this rather than hiding it:

- The web app polls `/api/core/healthz` on load and shows **"Waking the
  demo…"** until core-api answers (`apps/web/lib/wake.ts`).
- core-api pings ai-service's `/healthz` as its first act on boot, so both
  wake in parallel.
- Extraction runs from the outbox. If ai-service is still asleep the call
  fails, the event backs off (2s, 4s, 8s … up to 5 min) and is retried; after
  `OUTBOX_MAX_ATTEMPTS` the invoice goes to HOLD with
  `POLICY_MANUAL_REVIEW_REQUIRED` instead of vanishing.
- There is no always-on worker. Pending events are drained on core-api boot,
  after each write, and every `OUTBOX_POLL_MS` while it is awake. Opening the
  web app wakes core-api, which drains whatever was left.
  `node dist/cli/drain.js` does a one-shot drain for an external scheduler.

## The demo is open by design

`AUTH_MODE=demo` makes every caller the same demo user (roles: `cfo`) in one
demo tenant. Nothing private belongs there. For a real deployment set
`AUTH_MODE=oidc` with `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` and,
if your provider names them differently, `OIDC_TENANT_CLAIM` (default
`tenant_id`) and `OIDC_ROLES_CLAIM` (default `roles`). Create each tenant with
`MIGRATION_DATABASE_URL=… node dist/cli/bootstrap-tenant.js --name "Acme"`.
