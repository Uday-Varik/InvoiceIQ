variable "name_prefix" {
  description = "Prefix for every hosted resource name."
  type        = string
  default     = "invoiceiq"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name_prefix))
    error_message = "name_prefix must be lower-case letters, digits and dashes, 2 to 31 characters."
  }
}

variable "github_repo" {
  description = "GitHub repository as owner/name. Render builds from it and Vercel deploys from it."
  type        = string
  default     = "Uday-Varik/InvoiceIQ"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must look like owner/name."
  }
}

variable "branch" {
  description = "Branch every host deploys from."
  type        = string
  default     = "main"
}

variable "render_region" {
  description = "Render region for both backends. Keep it next to the Neon region."
  type        = string
  default     = "oregon"

  validation {
    condition     = contains(["frankfurt", "ohio", "oregon", "singapore", "virginia"], var.render_region)
    error_message = "render_region must be one of frankfurt, ohio, oregon, singapore, virginia."
  }
}

variable "render_plan" {
  description = "Render instance plan. free sleeps after idling (ADR-0008); starter stays up."
  type        = string
  default     = "free"
}

variable "neon_region" {
  description = "Neon region. aws-us-west-2 sits next to Render oregon."
  type        = string
  default     = "aws-us-west-2"
}

variable "vercel_team" {
  description = "Vercel team slug or id. Null uses the token's personal account."
  type        = string
  default     = null
}

variable "auth_mode" {
  description = "demo: one shared open tenant (the public demo). oidc: real users from an identity provider. github: session mode — real accounts via GitHub, Google, Apple, and/or email/password, with server-side sessions (ADR-0022)."
  type        = string
  default     = "demo"

  validation {
    condition     = contains(["demo", "oidc", "github"], var.auth_mode)
    error_message = "auth_mode must be demo, oidc, or github."
  }
}

variable "frontend_url" {
  description = "Public origin of the web app, e.g. https://invoice-iq-web.vercel.app (no trailing slash). Required when auth_mode is github: OAuth callbacks and post-login redirects point here."
  type        = string
  default     = null
}

variable "session_auth" {
  description = "Provider credentials for auth_mode = github (session mode). Required when auth_mode is github. Each provider is optional, but at least one provider (or credentials auth) must be configured or nobody can sign in. Secrets stay in Terraform state: treat state as sensitive."
  type = object({
    github_client_id     = optional(string)
    github_client_secret = optional(string)
    github_callback_url  = optional(string)
    google_client_id     = optional(string)
    google_client_secret = optional(string)
    google_callback_url  = optional(string)
    apple_client_id      = optional(string)
    apple_team_id        = optional(string)
    apple_key_id         = optional(string)
    apple_private_key    = optional(string)
    apple_callback_url   = optional(string)
    credentials_enabled  = optional(bool, false)
    session_secret       = optional(string)
    mfa_secret_key       = optional(string)
  })
  default   = null
  sensitive = true
}

variable "oidc" {
  description = "Identity provider settings, required when auth_mode is oidc."
  type = object({
    issuer       = string
    audience     = string
    jwks_url     = string
    tenant_claim = optional(string, "tenant_id")
    roles_claim  = optional(string, "roles")
  })
  default = null
}

variable "rate_limit_writes_per_minute" {
  description = "Per client address; 0 turns the limit off."
  type        = number
  default     = 120
}

variable "rate_limit_uploads_per_minute" {
  description = "Per client address; 0 turns the limit off."
  type        = number
  default     = 20
}

variable "trust_proxy_hops" {
  description = "Proxies in front of core-api whose X-Forwarded-For entries are trusted."
  type        = number
  default     = 1
}

variable "extraction_provider" {
  description = "AI extraction provider: heuristic (offline) or qwen (via OpenRouter)."
  type        = string
  default     = "heuristic"

  validation {
    condition     = contains(["heuristic", "qwen"], var.extraction_provider)
    error_message = "extraction_provider must be heuristic or qwen."
  }
}

variable "openrouter_api_key" {
  description = "OpenRouter API key for the Qwen provider. Required when extraction_provider is qwen."
  type        = string
  default     = null
  sensitive   = true
}
