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
  description = "demo: one shared open tenant (the public demo). oidc: real users from an identity provider."
  type        = string
  default     = "demo"

  validation {
    condition     = contains(["demo", "oidc"], var.auth_mode)
    error_message = "auth_mode must be demo or oidc."
  }
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
