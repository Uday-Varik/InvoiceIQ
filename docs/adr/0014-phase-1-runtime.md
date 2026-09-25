# ADR-0014: Phase 1 runtime: in-process outbox relay, signed service calls, documents in Postgres

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Phase 1 makes the skeleton run end to end on free tiers that scale to zero
(ADR-0008). Four choices were left open by earlier ADRs: who drains the outbox
when there is no always-on worker, how ai-service knows a call came from
core-api, where uploaded documents live, and how a public demo authenticates.

## Decision

- **Outbox relay runs inside core-api (wake-and-drain).** It drains on boot,
  right after each write that enqueues work, and on a slow poll while the
  process is awake. Claims use `FOR UPDATE SKIP LOCKED` with a lease, failed
  events back off exponentially, and exhausted events dead-letter into a HOLD
  with `POLICY_MANUAL_REVIEW_REQUIRED`. The cross-tenant claim is one
  `SECURITY DEFINER` function, `claim_outbox`; everything else the relay does
  runs under the event's tenant with RLS.
- **core-api signs every ai-service call** with HMAC-SHA256 over timestamp,
  method, path and body hash (`X-IIQ-Timestamp`, `X-IIQ-Signature`), with a
  300-second window. Both sides test one shared vector.
- **Documents are stored in Postgres** (`documents.content bytea`, 10 MiB cap),
  keyed by tenant and sha256. Free container disks are ephemeral, so local
  disk would lose documents on every sleep.
- **Auth has two modes.** `oidc` verifies RS256/ES256/EdDSA JWTs against a JWKS
  and takes the tenant and roles from claims. `demo` must be chosen
  explicitly and maps every caller to one demo user in one demo tenant.

## Consequences

- No extra service or scheduler to run or pay for; latency after idle is one
  cold start, which the web app shows as "Waking the demo".
- Throughput is bounded by one core-api process per instance draining in
  small batches. Two instances are safe (SKIP LOCKED) but do not scale
  linearly. Revisit with a dedicated worker when volume demands it.
- Postgres storage grows with documents. Move to object storage behind the
  same `insertDocument`/`getDocument` functions before real volume.
- A shared HMAC secret is simpler than mTLS or minted tokens but must be
  rotated by redeploying both services together.

## Alternatives considered

- **pg-boss / graphile-worker.** Solid, but both assume a long-running worker
  process; the in-process relay needs about 150 lines and fits scale-to-zero.
- **A cron-triggered drain only.** Free cron adds minutes of latency to every
  upload. Kept as an option: `dist/cli/drain.js` does a one-shot drain.
- **Local disk or S3 for documents now.** Disk is lost on sleep; S3 adds an
  account and credentials the demo does not need yet.
- **Short-lived JWTs between services.** Needs a key-distribution story first;
  HMAC gives the same guarantee for one caller.
