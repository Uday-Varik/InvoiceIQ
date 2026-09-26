locals {
  repo_url = "https://github.com/${var.github_repo}"

  oidc_env = var.auth_mode == "oidc" ? {
    OIDC_ISSUER       = { value = var.oidc.issuer }
    OIDC_AUDIENCE     = { value = var.oidc.audience }
    OIDC_JWKS_URL     = { value = var.oidc.jwks_url }
    OIDC_TENANT_CLAIM = { value = var.oidc.tenant_claim }
    OIDC_ROLES_CLAIM  = { value = var.oidc.roles_claim }
  } : {}
}

# ai-service: extraction and advisory signals. It gets no database credentials
# at all (ADR-0007), only the secret core-api signs requests with.
resource "render_web_service" "ai" {
  name              = "${var.name_prefix}-ai-service"
  plan              = var.render_plan
  region            = var.render_region
  health_check_path = "/healthz"

  runtime_source = {
    docker = {
      repo_url        = local.repo_url
      branch          = var.branch
      auto_deploy     = true
      context         = "."
      dockerfile_path = "./services/ai-service/Dockerfile"
      build_filter = {
        paths = [
          "services/ai-service/**",
          "packages/contracts/generated/python/**",
          "pyproject.toml",
          "uv.lock",
        ]
      }
    }
  }

  env_vars = {
    AI_SIGNING_SECRET = { value = random_password.ai_signing_secret.result }
    METRICS_TOKEN     = { value = random_password.metrics_token.result }
    LOG_LEVEL         = { value = "info" }
  }
}

# core-api: the only service with database credentials and the only one that
# can move an invoice.
resource "render_web_service" "core" {
  name   = "${var.name_prefix}-core-api"
  plan   = var.render_plan
  region = var.render_region
  # Liveness only. /readyz also checks Postgres; point an uptime monitor at it,
  # not Render, so a slow Neon wake-up never restarts a healthy instance.
  health_check_path          = "/healthz"
  max_shutdown_delay_seconds = 30

  runtime_source = {
    docker = {
      repo_url        = local.repo_url
      branch          = var.branch
      auto_deploy     = true
      context         = "."
      dockerfile_path = "./services/core-api/Dockerfile"
      build_filter = {
        paths = [
          "services/core-api/**",
          "packages/contracts/**",
          "package.json",
          "pnpm-lock.yaml",
        ]
      }
    }
  }

  env_vars = merge(
    {
      NODE_ENV                      = { value = "production" }
      DATABASE_URL                  = { value = local.database_url }
      MIGRATION_DATABASE_URL        = { value = local.migration_database_url }
      APP_DB_PASSWORD               = { value = random_password.app_db.result }
      AI_SERVICE_URL                = { value = render_web_service.ai.url }
      AI_SIGNING_SECRET             = { value = random_password.ai_signing_secret.result }
      AUTH_MODE                     = { value = var.auth_mode }
      AUDIT_CHECKPOINT_KEY          = { value = tls_private_key.audit_checkpoint.private_key_pem_pkcs8 }
      METRICS_TOKEN                 = { value = random_password.metrics_token.result }
      RATE_LIMIT_WRITES_PER_MINUTE  = { value = tostring(var.rate_limit_writes_per_minute) }
      RATE_LIMIT_UPLOADS_PER_MINUTE = { value = tostring(var.rate_limit_uploads_per_minute) }
      TRUST_PROXY_HOPS              = { value = tostring(var.trust_proxy_hops) }
    },
    local.oidc_env,
  )

  lifecycle {
    precondition {
      condition     = var.auth_mode == "demo" || var.oidc != null
      error_message = "auth_mode = \"oidc\" needs the oidc variable (issuer, audience, jwks_url)."
    }
  }
}
