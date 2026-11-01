locals {
  repo_url = "https://github.com/${var.github_repo}"

  oidc_env = var.auth_mode == "oidc" ? {
    OIDC_ISSUER       = { value = var.oidc.issuer }
    OIDC_AUDIENCE     = { value = var.oidc.audience }
    OIDC_JWKS_URL     = { value = var.oidc.jwks_url }
    OIDC_TENANT_CLAIM = { value = var.oidc.tenant_claim }
    OIDC_ROLES_CLAIM  = { value = var.oidc.roles_claim }
  } : {}

  # Session mode (auth_mode = "github", ADR-0022). Only the configured
  # providers get variables: the backend advertises exactly the providers
  # whose credentials are present, so an unconfigured provider stays off.
  session_env = var.auth_mode == "github" && var.session_auth != null ? merge(
    {
      SESSION_SECRET = { value = coalesce(var.session_auth.session_secret, random_password.session_secret.result) }
      FRONTEND_URL   = { value = var.frontend_url }
    },
    var.session_auth.github_client_id != null ? {
      GITHUB_CLIENT_ID     = { value = var.session_auth.github_client_id }
      GITHUB_CLIENT_SECRET = { value = var.session_auth.github_client_secret }
      GITHUB_CALLBACK_URL  = { value = var.session_auth.github_callback_url }
    } : {},
    var.session_auth.google_client_id != null ? {
      GOOGLE_CLIENT_ID     = { value = var.session_auth.google_client_id }
      GOOGLE_CLIENT_SECRET = { value = var.session_auth.google_client_secret }
      GOOGLE_CALLBACK_URL  = { value = var.session_auth.google_callback_url }
    } : {},
    var.session_auth.apple_client_id != null ? {
      APPLE_CLIENT_ID     = { value = var.session_auth.apple_client_id }
      APPLE_TEAM_ID       = { value = var.session_auth.apple_team_id }
      APPLE_KEY_ID        = { value = var.session_auth.apple_key_id }
      APPLE_PRIVATE_KEY   = { value = var.session_auth.apple_private_key }
      APPLE_CALLBACK_URL  = { value = var.session_auth.apple_callback_url }
    } : {},
    var.session_auth.credentials_enabled ? {
      CREDENTIALS_AUTH_ENABLED = { value = "true" }
    } : {},
    var.session_auth.mfa_secret_key != null ? {
      MFA_SECRET_KEY = { value = var.session_auth.mfa_secret_key }
    } : {},
  ) : {}
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

  env_vars = merge(
    {
      AI_SIGNING_SECRET   = { value = random_password.ai_signing_secret.result }
      METRICS_TOKEN       = { value = random_password.metrics_token.result }
      EXTRACTION_PROVIDER = { value = var.extraction_provider }
      LOG_LEVEL           = { value = "info" }
    },
    var.openrouter_api_key != null ? {
      OPENROUTER_API_KEY = { value = var.openrouter_api_key }
    } : {},
  )
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
    local.session_env,
  )

  lifecycle {
    precondition {
      condition     = var.auth_mode == "demo" || var.oidc != null
      error_message = "auth_mode = \"oidc\" needs the oidc variable (issuer, audience, jwks_url)."
    }
    precondition {
      condition = var.auth_mode != "github" || (
        var.session_auth != null && var.frontend_url != null && (
          var.session_auth.github_client_id != null ||
          var.session_auth.google_client_id != null ||
          var.session_auth.apple_client_id != null ||
          var.session_auth.credentials_enabled
        ) &&
        (var.session_auth.github_client_id == null || (
          var.session_auth.github_client_secret != null && var.session_auth.github_callback_url != null
        )) &&
        (var.session_auth.google_client_id == null || (
          var.session_auth.google_client_secret != null && var.session_auth.google_callback_url != null
        )) &&
        (var.session_auth.apple_client_id == null || (
          var.session_auth.apple_team_id != null &&
          var.session_auth.apple_key_id != null &&
          var.session_auth.apple_private_key != null &&
          var.session_auth.apple_callback_url != null
        ))
      )
      error_message = "auth_mode = \"github\" needs frontend_url and session_auth with at least one complete provider (GitHub, Google, Apple) or credentials_enabled."
    }
  }
}
