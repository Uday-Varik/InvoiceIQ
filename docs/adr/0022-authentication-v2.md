# ADR-0022: Authentication v2 — server-side sessions, credential lifecycle, MFA, RBAC, audit trail

- **Status:** Accepted
- **Date:** 2026-11-01
- **Supersedes:** parts of ADR-0021 (session design, credential lifecycle, Terraform gap)

## Context

ADR-0021 switched the live deployment to real accounts behind one
session-cookie mode, but left the authentication layer half-built for
production: the session was a stateless HMAC-signed payload, so there
was no way to revoke a single sign-in or end every session for an
account; email/password accounts had no verification, reset, or
lockout; there was no second factor; the admin role check alone gated
every tenant, so a CFO of one tenant could manage another tenant's
members; and there was no record of who signed in, when, or what
changed. Terraform still could not enable session mode at all.

The redo had to cover present, past, and future: fix what exists,
close the holes, and leave no part of authentication needing another
rewrite — without swapping to a hosted identity provider, which would
discard working provider code and add a vendor dependency.

## Decision

### Server-side sessions (S1)

Sessions are opaque random tokens. Only a SHA-256 hash is stored, in
the owner-only `sessions` table, with provider, identity, tenant,
roles, MFA state, user agent, and a hashed client IP. The cookie
(`iq_session`, 7 days, HttpOnly, SameSite=Lax, Secure in production)
carries no identity at all. Consequences, all deliberate:

- Any session can be revoked individually, all of an identity's
  sessions can be ended, and role changes revoke the affected
  tenant's sessions, so new roles take effect at next sign-in.
- Rotating `SESSION_SECRET` no longer signs users out: the secret now
  signs only short-lived MFA step-up tokens. Rotation still
  invalidates in-flight step-up tokens (10 minutes).
- Roles in a session are a snapshot of membership at sign-in time.
  Membership changes revoke sessions so the snapshot cannot go stale.

Demo and OIDC modes are untouched; only session mode uses the table.

### Credential lifecycle (S2)

Email/password accounts require verification before sign-in, with
single-use hashed tokens (24-hour verification, 1-hour reset) and a
resend path that never reveals whether an address exists. Five bad
passwords lock the account for 15 minutes; unknown emails are checked
against a dummy scrypt hash so timing reveals nothing. Passwords need
12 characters. A reset and a password change end every other session
for the account.

Email delivery is a `Mailer` seam with only a log mailer today: no
email leaves the server, and the runbook says so. A real provider
plugs into the seam; enabling credentials before that strands new
accounts, because verification links exist only in server logs.

### TOTP MFA (S3)

Optional per-user TOTP (RFC 6238, SHA-1, 30-second steps, ±1 step
window), enforced at sign-in for every provider. Secrets are stored
AES-256-GCM encrypted, with the key derived from `MFA_SECRET_KEY`
when set, else from `SESSION_SECRET` with a startup warning.
Recovery codes (10, single-use, hashed) are shown exactly once at
enable time. Setup stays disabled until a code proves the
authenticator works. After primary authentication, an MFA user gets a
short-lived signed pending token instead of a session; the challenge
endpoint exchanges it for an MFA-verified session.

Rotating the MFA encryption key without re-encrypting secrets locks
every MFA user out. There is no automated re-encryption; rotation
means users re-enroll. The runbook states this plainly rather than
pretending otherwise.

### RBAC matrix and membership governance (S4)

Permissions are stated once (`src/auth/permissions.ts`), mirroring the
`requireRole` thresholds already enforced in the domain services —
the matrix never widens them. A tenant owner holds every permission
in their tenant. Principals carry provider and external id, so
tenant-scoped admin routes require membership in the target tenant
plus `members:manage`, closing the cross-tenant hole. Membership
changes have guardrails (a tenant keeps at least one owner; nobody
removes or demotes the last owner, including themself), a PATCH
endpoint for roles and owner flag, and session revocation in the
affected tenant.

### Auth audit trail (S4)

Every auth event — sign-in, sign-out, registration, verification,
reset, password change, MFA setup/disable/challenge, member changes,
session revocation, tenant switch — is written to the owner-only
`auth_events` table with a hashed client IP, readable by tenant
admins. A failed audit write fails the request: a gap in this trail
is not silent.

### Terraform session mode (S5)

`auth_mode` gains `github`, with a `session_auth` object for provider
credentials, `frontend_url`, and optional `MFA_SECRET_KEY`. Only
configured providers get variables, so an unconfigured provider stays
off. Preconditions require a frontend URL and at least one complete
provider (or credentials) in session mode. Terraform was never
applied to the live deployment, which was set up through dashboards;
the Terraform route is now available but unapplied, and that fact is
unchanged.

## Deliberate gaps

- No transactional mail provider yet (the `Mailer` seam is the
  boundary; verification and reset emails go to logs until one is
  chosen).
- No automated MFA-key re-encryption procedure.
- Free-tier sleep and the single-instance in-memory rate limiter
  remain; paid tiers and a shared limiter are separate work.
- Threat-model T-03's mitigation text is updated to the session
  design; the threat count is unchanged.

## Consequences

Authentication needs no further structural work: sessions revoke,
credentials have a full lifecycle, MFA is per-user and optional,
membership is governed, and every auth event is recorded. Future
work is additive — a mail provider, more login methods — behind the
seams built here, not another rewrite.
