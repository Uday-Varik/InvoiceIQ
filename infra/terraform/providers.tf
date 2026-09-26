# Credentials come from the environment, never from files in this repo:
#   NEON_API_KEY, RENDER_API_KEY, RENDER_OWNER_ID, VERCEL_API_TOKEN
provider "neon" {}

provider "render" {
  # Each service waits for its first deploy, so core-api starts after
  # ai-service has a URL that answers.
  wait_for_deploy_completion = true
}

provider "vercel" {
  team = var.vercel_team
}
