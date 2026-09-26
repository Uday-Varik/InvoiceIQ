# apps/web on Vercel. The browser only talks to this origin; /api/core/* is
# rewritten to core-api server-side, so there is no CORS surface and the API
# URL never reaches client bundles.
resource "vercel_project" "web" {
  name           = var.name_prefix
  framework      = "nextjs"
  root_directory = "apps/web"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = var.branch
  }
}

resource "vercel_project_environment_variable" "core_api_url" {
  project_id = vercel_project.web.id
  key        = "CORE_API_URL"
  value      = render_web_service.core.url
  target     = ["production", "preview"]
  sensitive  = false
  comment    = "Where /api/core/* is proxied (core-api on Render)."
}
