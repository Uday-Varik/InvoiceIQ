# ADR-0001: One monorepo with pnpm and uv workspaces

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

InvoiceIQ has three deployables in two languages (TypeScript and Python) that
share one set of API contracts, one reason catalog and one threat model. The
most expensive failure mode for a payment-safety product is drift: a reason
code added in core-api that ai-service does not know about, or a contract field
renamed on one side only.

## Decision

Keep everything in one repository.

- TypeScript packages use **pnpm workspaces** (`apps/*`, `services/core-api`,
  `packages/*`) with exact version pins.
- Python packages use a **uv workspace** (`services/ai-service`, `data`,
  `packages/contracts`) with one lockfile.
- A single `make check` runs every lint, type check, test and drift check for
  both languages and is the only gate CI runs.

## Consequences

- One pull request can change a contract and every consumer atomically.
- Guardrail tests can read code, contracts and docs side by side (see
  `tests/guardrails/`).
- CI must install two toolchains. Caching keeps this to roughly a minute.
- Repository permissions are coarse; CODEOWNERS is used to route reviews.

## Alternatives considered

- **Polyrepo per service.** Rejected: contracts would need publishing and
  version negotiation before there is a second team to justify it.
- **Nx or Turborepo.** Deferred: `pnpm -r` plus Make is enough at this size, and
  adds no build graph to learn. Revisit when CI exceeds ten minutes.
