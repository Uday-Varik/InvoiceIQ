# Terraform: the hosted stack on free tiers

Creates everything ADR-0008 describes, in one `terraform apply`:

| Resource | Provider | What it is |
| --- | --- | --- |
| `neon_project.db` | Neon | Postgres 16, database `invoiceiq`, owner role `invoiceiq_owner` |
| `render_web_service.ai` | Render | ai-service from `services/ai-service/Dockerfile`, no database credentials (ADR-0007) |
| `render_web_service.core` | Render | core-api from `services/core-api/Dockerfile`; migrates and bootstraps on boot |
| `vercel_project.web` + `CORE_API_URL` | Vercel | apps/web, proxying `/api/core/*` to core-api |
| `random_password.*`, `tls_private_key.audit_checkpoint` | random, tls | App DB password, ai-service signing secret, metrics token, Ed25519 checkpoint key |

This is an alternative to the click-through Blueprint in `render.yaml` and
[docs/runbooks/deploy-free-tier.md](../../docs/runbooks/deploy-free-tier.md).
Use one or the other for a given account, not both.

## Verification status

- **Verified in the sandbox:** `terraform fmt -check` and `terraform validate`
  against the real provider schemas (neon 0.18.0, render 1.8.0, vercel 4.8.0,
  random 3.9.1, tls 4.4.1). CI runs both on every PR (`terraform` job).
- **Written-unverified (W-UNV):** `terraform apply`. The sandbox that wrote this
  has no Neon, Render or Vercel account. Nothing here has created a real resource.

## Apply it

```bash
export NEON_API_KEY=...        # Neon: Account settings, API keys
export RENDER_API_KEY=...      # Render: Account settings, API keys
export RENDER_OWNER_ID=usr-... # or tea-... for a team
export VERCEL_API_TOKEN=...    # Vercel: Account settings, Tokens

cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # adjust if needed
cp backend.tf.example backend.tf               # recommended: remote, encrypted state
terraform init            # commit the .terraform.lock.hcl it writes
terraform plan
terraform apply
scripts/smoke.sh "$(terraform output -raw core_api_url)"
```

Render and Vercel must be allowed to read the GitHub repository (install their
GitHub apps on it) before the first apply.

## What happens on first boot

1. core-api runs the migrations as `invoiceiq_owner` (direct host). Migration
   0001 creates `invoiceiq_app` without login.
2. With `APP_DB_PASSWORD` set, core-api gives `invoiceiq_app` LOGIN and that
   password, then connects with `DATABASE_URL` (pooled host). This replaces the
   hand-run `ALTER ROLE` step of the manual runbook, and re-applies on every
   boot, so rotating the password is `terraform apply -replace=random_password.app_db`.
3. In demo mode the demo tenant is bootstrapped.

The app role is created by our migration on purpose, not by a `neon_role`
resource: roles made through Neon's API are members of `neon_superuser`, which
has BYPASSRLS, and row-level security is the tenant boundary (ADR-0004,
ADR-0017). core-api refuses to enable a login for a role that bypasses RLS.

## Secrets

Every generated secret lives in Terraform state and in the hosts' environment
settings, nowhere else. Keep state in an encrypted remote backend; never commit
`terraform.tfstate` or `terraform.tfvars` (both are git-ignored).

| Output | Use |
| --- | --- |
| `core_api_url`, `readiness_url` | Smoke test; point an uptime monitor at `/readyz` |
| `metrics_token` (sensitive) | Bearer token for `/metrics` on both backends |
| `audit_checkpoint_public_key_pem` | Give to whoever verifies exported audit checkpoints |

## Observability

Scrape both backends' `/metrics` with the metrics token (Grafana Cloud's free
tier works with a hosted Prometheus scrape job), load the rules in
`infra/observability/alerts.yml` and import `infra/observability/dashboard.json`.
See [docs/runbooks/observability.md](../../docs/runbooks/observability.md).
