# ADR-0021: Production sign-in: session-cookie providers (GitHub, Google, Apple, credentials)

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

The public deployment ran in demo mode (`AUTH_MODE=demo`), where there are
no accounts: every visitor is the same demo user in one shared tenant, and
a cookie lets anyone pick any role. The login page therefore skipped
sign-in entirely and sent everyone to the dashboard, the page ignored the
`?tab=signup` flag so Get started and Sign in were identical, and
onboarding ended on the marketing homepage. GitHub and Google sign-in and
email/password sign-in were already implemented but never enabled live;
Apple Sign In did not exist at all. The sign-in endpoints had no rate
limiting, and a new email/password account skipped onboarding and landed
in the shared demo tenant with CFO rights. Terraform's auth setting only
knows demo and OIDC, so none of this could be switched on from
infrastructure code.

The product needs real accounts: a new user must be able to create an
account, an existing user must be able to sign in, and both must be able
to do it with GitHub, Google, Apple, or email and password — on the live
deployment, not just in a demo.

## Decision

### One session-cookie mode for all browser providers

`AUTH_MODE=github` is the session-cookie mode, despite the name: it gates
GitHub, Google, Apple, and credentials alike. `/auth/providers` advertises
a provider only when its credentials are fully present, so a half-configured
provider never renders a dead button. The login page honors `?tab=signup`
(sign-up copy explains that a first OAuth sign-in creates the account),
shows an error with a retry when the providers request fails instead of
inventing a button, and shows an explicit not-set-up message when no
provider is configured.

Sessions are HMAC-SHA256-signed cookies (`iq_session`, 7 days, HttpOnly,
SameSite=Lax, Secure in production). The payload is signed, not encrypted:
it carries the login label, tenant, and roles, and nothing secret. That is
accepted deliberately — integrity is what the server trusts — and is
recorded here so it is a choice, not an oversight. There is no CSRF token
beyond SameSite=Lax and the OAuth state cookies.

### Apple Sign In, built like Google's

A new `auth/apple.ts` mirrors `auth/google.ts`: state and nonce cookies,
`form_post` callback (the urlencoded body is parsed with Node's querystring
parser; no new dependency), `id_token` verified against Apple's JWKS with
the nonce checked, and the `client_secret` JWT (ES256, six-month lifetime)
signed with the Service ID private key using the already-installed `jose`
package. New Apple users go to onboarding; returning users go to the
dashboard. Config fails fast when only part of the Apple credentials are
set. Apple live setup needs a paid Apple Developer account, a Service ID,
and a private key; that is owner dashboard work, not code.

### Onboarding and credentials behave the same for everyone

Onboarding now lands on `/dashboard` after creating or picking an
organization, and a user who already belongs to an organization is offered
to continue with it instead of only being offered a new one. Email/password
sign-up redirects to onboarding (like a first OAuth sign-in); sign-in
redirects to the dashboard. New credential accounts therefore no longer
silently share the demo tenant.

### Auth endpoints are throttled

A new `auth` rate-limit bucket (60 attempts per minute per address by
default, `RATE_LIMIT_AUTH_PER_MINUTE`) covers every `/auth/*` route that
starts, completes, or ends a session. The read-only `/auth/providers` and
`/auth/me` lookups stay unlimited so the login page and onboarding keep
working while the backend wakes up. The limiter is in-memory per instance,
which matches the single-instance free-tier deployment; a multi-instance
deployment needs a shared store.

### What is deliberately not in this decision

Email verification and password reset are not implemented: the app has no
mail provider, and inventing one was out of scope. Credential accounts work
without verification for now; adding verification is a follow-up that
starts with choosing a mail provider. Terraform is untouched: enabling
session mode stays a Render-dashboard task until the Terraform variables
gain provider support. The threat model's T-03 (short-lived JWT, MFA)
does not describe this session-cookie design; revisiting it is a follow-up,
not a silent edit to the threat model.

## Consequences

- Switching the live deployment to real accounts is dashboard work, in
  order: provider apps (GitHub OAuth app, Google Cloud OAuth client, Apple
  Service ID), Render variables (provider credentials, callback URLs,
  `FRONTEND_URL`, then `AUTH_MODE=github` last, because boot validation
  refuses GitHub mode without its credentials), and Vercel Deployment
  Protection off so the public can reach the app at all. The callback URLs
  must be the stable production domain, with no trailing slash, and must
  match the provider apps exactly, or the session cookie lands on the wrong
  origin and sign-in silently fails.
- Demo mode is retained (`AUTH_MODE=demo`) for the public demo; the persona
  bar and shared tenant only exist there.
- `/v1/me` still reports `authMode: github` for every session provider;
  distinguishing providers there would be a contract change and was not
  needed for the login experience.
- Live provider journeys (each button, first and returning user, sign-out)
  must be verified in the browser after the dashboard setup; CI proves the
  code paths and the Apple JWT shape, not the provider consoles.

## Alternatives considered

- **Hosted identity provider (Clerk, Auth0, or generic OIDC):** the OIDC
  mode already exists for API clients, but the browser flows, tenant
  onboarding, and session handling were already built for OAuth; adding a
  vendor would replace working code with a new dependency and a new bill.
  Revisit if verification, reset, MFA, or passkeys become requirements.
- **Passkeys / WebAuthn:** deferred. No WebAuthn infrastructure exists,
  and the four chosen methods cover the requested sign-in surface.
- **Encrypting the session cookie:** deferred. The payload holds no
  secrets; HMAC integrity is the property the server relies on.
