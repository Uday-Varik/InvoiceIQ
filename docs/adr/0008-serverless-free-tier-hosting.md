# ADR-0008: Serverless free-tier hosting

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

InvoiceIQ is a portfolio-grade project with no revenue. It needs to be
demonstrable online with near-zero idle cost, while keeping an architecture
that would survive a move to paid infrastructure.

## Decision

- `apps/web` on a serverless Next.js host with a free tier.
- `core-api` and `ai-service` as containers on a scale-to-zero platform.
- Postgres on a serverless Postgres provider that supports RLS, `SKIP LOCKED`
  and branching for preview environments.
- All three are built from the same Dockerfiles used locally. Infrastructure is
  described in `infra/` (Terraform, **Written-unverified** until Phase 4).

## Consequences

- Cold starts on the first request after idle. Acceptable for a demo; the
  outbox relay (ADR-0003) tolerates delayed workers.
- Free tiers change. Nothing in the code depends on a vendor SDK, so moving is
  a deployment change only.
- No always-on worker: queue draining is triggered by requests or a scheduler.

## Alternatives considered

- **Single VM with docker-compose.** Cheap but always-on and hand-patched.
- **Kubernetes.** Rejected at this scale on cost and operational load.
  `infra/k8s/` holds unverified manifests only as a reference.
