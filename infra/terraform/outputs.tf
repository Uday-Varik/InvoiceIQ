output "core_api_url" {
  description = "core-api base URL. Smoke it with scripts/smoke.sh <url>."
  value       = render_web_service.core.url
}

output "ai_service_url" {
  description = "ai-service base URL (signed requests only)."
  value       = render_web_service.ai.url
}

output "readiness_url" {
  description = "Point an uptime monitor here."
  value       = "${render_web_service.core.url}/readyz"
}

output "vercel_project_id" {
  value = vercel_project.web.id
}

output "neon_project_id" {
  value = neon_project.db.id
}

output "metrics_token" {
  description = "Bearer token for /metrics on both backends (Grafana Cloud or any Prometheus scraper)."
  value       = random_password.metrics_token.result
  sensitive   = true
}

output "audit_checkpoint_public_key_pem" {
  description = "Public half of the checkpoint key: give it to whoever verifies exported checkpoints."
  value       = trimspace(tls_private_key.audit_checkpoint.public_key_pem)
}
