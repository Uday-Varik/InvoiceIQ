# Generated once and kept in state. Rotate one with
#   terraform apply -replace=random_password.<name>
# core-api re-applies APP_DB_PASSWORD on every boot, so a rotation needs no SQL.

resource "random_password" "app_db" {
  length  = 40
  special = false # goes into a connection URL
}

resource "random_password" "ai_signing_secret" {
  length  = 64
  special = false
}

resource "random_password" "metrics_token" {
  length  = 48
  special = false
}

# Signs session cookies in github (session) mode, and encrypts TOTP
# secrets when MFA_SECRET_KEY is unset. Generated once and kept in
# state; rotating it does NOT sign users out (sessions are server-side
# rows, ADR-0022), but it invalidates in-flight MFA step-up tokens.
# Supply session_secret in session_auth instead to manage it yourself.
resource "random_password" "session_secret" {
  length  = 64
  special = false
}

# Signs audit checkpoints. A stable key means checkpoints stay verifiable
# across restarts (ADR-0016); publish the public half where auditors can read it.
resource "tls_private_key" "audit_checkpoint" {
  algorithm = "ED25519"
}
