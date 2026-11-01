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

**Terraform instead of clicking.** [`infra/terraform`](../../infra/terraform/README.md)
creates all three pieces and generates every secret (ADR-0017). It is validated
in CI but has not been applied either (W-UNV). The manual steps below are the
same layout by hand.

## 1. Neon

1. Create a project with Postgres 16. The default role (for example
   `neondb_owner`) owns the schema and runs migrations.
2. Run the first migration once, or let core-api do it on boot (step 2). It
   creates `invoiceiq_app` **without login**. Generate a password of at
   least 24 characters and set it as `APP_DB_PASSWORD` on core-api (step 2):
   boot gives the role LOGIN with it after migrating. Do not create the role
   in Neon's console or API; Neon makes such roles members of
   `neon_superuser`, which can bypass row-level security.

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
   `APP_DB_PASSWORD` and `AI_SERVICE_URL` (the ai-service's
   `https://…onrender.com` URL). `METRICS_TOKEN` is generated in the shared
   group; Prometheus sends it as a bearer token (see
   [observability.md](observability.md)).
3. Deploy. core-api migrates, bootstraps the demo tenant and starts draining
   the outbox. Check `https://<core-api>/healthz`, then `/readyz`.
4. Smoke it: `scripts/smoke.sh https://<core-api>.onrender.com`.

## 3. Vercel

1. Import the repo, set **Root Directory** to `apps/web`, keep "Include files
   outside the root directory" on (pnpm workspace).
2. Set `CORE_API_URL=https://<core-api>.onrender.com` for Production and
   Preview. The browser never calls core-api directly: `/api/core/*` is
   rewritten to it, so there is no CORS to configure.

## 4. Real sign-in (production)

Demo mode (`AUTH_MODE=demo`) has no accounts. For real accounts, switch
core-api to session mode (`AUTH_MODE=github` — the name covers all
browser providers, not just GitHub) and configure at least one provider.
Decision record: [ADR-0021](../adr/0021-production-sign-in.md).

### 4.1 Pick the stable frontend domain first

Every callback URL and redirect below must use the Vercel project's stable
production domain — the domain Vercel shows for the Production deployment,
not a per-deployment URL with a hash in it, which changes on the next
deploy. Use the exact origin, with no trailing slash. If the project has
no stable production domain, add one in Vercel Settings → Domains first.

### 4.2 Provider apps (owner dashboard work; never paste secrets in chat)

**GitHub:** GitHub Settings → Developer settings → OAuth Apps → New OAuth
App. Homepage URL: the stable domain. Authorization callback URL:
`https://<stable-domain>/auth/github/callback`. Copy the Client ID, then
generate a client secret (shown once).

**Google:** Google Cloud Console → APIs & Services → Credentials → Create
OAuth client ID (Web application). Authorized redirect URI:
`https://<stable-domain>/auth/google/callback`. Copy the Client ID and
Client Secret. The consent screen needs the app name and a support email;
`openid email profile` scopes are the only ones requested.

**Apple:** Apple Developer Program (paid) → Certificates, Identifiers &
Profiles → Identifiers → App IDs (enable Sign In with Apple) and Services
IDs → New Services ID with Sign In with Apple enabled, configured with the
primary App ID and the domain + return URL
`https://<stable-domain>/auth/apple/callback`. Then Keys → new key with
Sign In with Apple enabled (select the primary App ID), download the .p8
file once, and note the Team ID and Key ID. The Service ID identifier is
the Client ID; the .p8 contents are the private key (paste the full PEM,
including the BEGIN/END lines; literal `\n` sequences are normalized by
the server, but real newlines are preferred).

**Email/password:** no external app. It is off unless
`CREDENTIALS_AUTH_ENABLED=true` is set. There is no email verification or
password reset yet — that needs a mail provider and is a follow-up.

### 4.3 Render variables on `invoiceiq-core-api`

Set these in the Render dashboard (Environment), in this order. Flip
`AUTH_MODE` last: boot validation refuses GitHub mode without its
credentials, so a service flipped early crash-loops until the rest land.

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (only if Google is offered) |
| `GOOGLE_CALLBACK_URL` | `https://<stable-domain>/auth/google/callback` |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Apple Service ID setup (only if Apple is offered; all four or none) |
| `APPLE_CALLBACK_URL` | `https://<stable-domain>/auth/apple/callback` |
| `CREDENTIALS_AUTH_ENABLED` | `true` only if email/password is offered |
| `SESSION_SECRET` | Already generated by the blueprint; if missing, generate one (at least 32 characters). Rotating it signs everyone out. |
| `FRONTEND_URL` | `https://<stable-domain>` (no trailing slash) |
| `AUTH_MODE` | `github` — set last, then let Render redeploy |

The callback URLs must match the provider apps exactly. If a callback
arrives on the Render origin instead of the Vercel origin, the session
cookie lands on the wrong host and sign-in silently fails — that is why
the explicit `*_CALLBACK_URL` variables exist. `CORS_ORIGIN` is not needed:
the browser only talks to the Vercel origin and `/auth/*` is proxied.

### 4.4 Vercel Deployment Protection off

In the Vercel project settings, turn Deployment Protection off (or it will
keep asking every visitor to log in to Vercel before the app's own sign-in
can appear). This is required for any public sign-in, in any mode.

### 4.5 Session and abuse notes (authentication v2, ADR-0022)

- Sessions are server-side rows keyed by a hash of an opaque token.
  The cookie (`iq_session`, 7 days, HttpOnly, SameSite=Lax, Secure in
  production) carries no identity. Any session can be revoked from
  Account & security, and role changes end the affected tenant's
  sessions.
- Rotating `SESSION_SECRET` does **not** sign users out. It only signs
  the short-lived MFA step-up tokens. Rotating `MFA_SECRET_KEY`
  without re-encrypting TOTP secrets locks every MFA user out; there
  is no automated re-encryption, so rotation means users re-enroll.
  If `MFA_SECRET_KEY` is unset, TOTP secrets fall back to
  `SESSION_SECRET` with a startup warning.
- Sign-in, sign-up, and OAuth callbacks are throttled at 60 attempts per
  minute per address (`RATE_LIMIT_AUTH_PER_MINUTE`). The limiter is
  in-memory per instance; a multi-instance deployment needs a shared
  store.
- Email/password verification and reset links are only logged today:
  the log mailer writes the full link to the server log and sends no
  email. Do not enable `CREDENTIALS_AUTH_ENABLED` for real users
  until a transactional mail provider is wired into the `Mailer`
  seam.
- Demo mode stays available via `AUTH_MODE=demo`. The persona bar and the
  shared tenant exist only there; flipping to GitHub mode removes the
  demo shortcut.
- Terraform can now enable session mode (`auth_mode = "github"` with
  `session_auth` and `frontend_url`); it has not been applied to the
  live deployment, which was set up through dashboards.

### 4.6 Verify it

1. `GET https://<core-api>/auth/providers` returns `authMode: github` and
   the providers you configured — and no others.
2. In a browser: Get started → provider button → first sign-in lands on
   onboarding; create an organization → dashboard. Sign out, sign in
   again with the same provider → dashboard directly, no onboarding.
3. Email/password (if enabled): sign up → onboarding; sign in → dashboard;
   a wrong password shows the form error, not a redirect loop.
4. Apple (if configured): first sign-in may ask for name/email sharing;
   a private-relay email is normal and works as the login label.

## 5. Operating authentication v2

- **Sessions:** Account & security lists every active session, with
  per-session revocation and "end all other sessions". A session
  lasts 7 days and is a snapshot of roles at sign-in; changing a
  member's roles or removing them ends their sessions in that tenant
  only.
- **Two-factor authentication:** per user, optional, from Account &
  security. Setup shows the secret once and ten single-use recovery
  codes once — neither is shown again. Disabling needs a current code
  or a recovery code. If a user loses both, an admin cannot reset MFA
  from the UI: remove and re-add the member, or clear the `user_mfa`
  row from the owner connection, and have them set it up again.
- **Members and roles:** tenant admins manage members from the admin
  UI or `PATCH /v1/admin/tenants/:tenantId/users/:userId`. A tenant
  always keeps at least one owner; the last owner cannot be removed
  or demoted, including by themself. Roles follow the permission
  matrix in `src/auth/permissions.ts`; a tenant owner holds every
  permission in their tenant.
- **Audit trail:** every auth event is recorded in `auth_events`
  (owner connection only). Tenant admins read it at
  `GET /v1/admin/tenants/:tenantId/auth-events`.
- **Secrets:** `SESSION_SECRET` rotation is safe (see §4.5).
  `MFA_SECRET_KEY` rotation is not: it requires re-enrollment. Never
  paste secret values in chat, issues, or docs.

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
demo tenant. Nothing private belongs there. For real accounts, see §4
above — do not point real users at the demo deployment and expect accounts
to exist. For token-based API access instead of browser sign-in, set
`AUTH_MODE=oidc` with `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` and,
if your provider names them differently, `OIDC_TENANT_CLAIM` (default
`tenant_id`) and `OIDC_ROLES_CLAIM` (default `roles`). Create each tenant with
`MIGRATION_DATABASE_URL=… node dist/cli/bootstrap-tenant.js --name "Acme"`.
