terraform {
  required_version = ">= 1.9.0"

  required_providers {
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.18"
    }
    render = {
      source  = "render-oss/render"
      version = "~> 1.8"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 4.8"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.4"
    }
  }

  # State holds generated secrets (database passwords, the signing secret, the
  # checkpoint key). Keep it in an encrypted remote backend, for example HCP
  # Terraform's free tier; see backend.tf.example. Local state is only for a
  # throwaway trial.
}
