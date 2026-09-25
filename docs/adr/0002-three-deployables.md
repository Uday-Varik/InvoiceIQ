# ADR-0002: Three deployables plus Postgres

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

The product has a reviewer-facing UI, a system of record that moves invoices
toward payment, and model-backed extraction and risk scoring. These parts have
very different trust levels. The model-backed part processes attacker-supplied
documents and must never be able to move money.

## Decision

Ship exactly three deployables and one database:

| Deployable | Stack | Owns |
| --- | --- | --- |
| `apps/web` | Next.js, React, TypeScript | Reviewer UI. No secrets beyond a session. |
| `services/core-api` | TypeScript, Fastify | Every money-bearing table, the lifecycle gate, the audit ledger. |
| `services/ai-service` | Python, FastAPI | Extraction and HOLD-only signals. No database credentials. |
| Postgres | 16+ | System of record, queue and outbox (ADR-0003). |

`apps/web` talks to services only through `@invoiceiq/contracts`; an ESLint
rule forbids importing service code directly.

## Consequences

- The trust boundary between core-api and ai-service is a network boundary
  with its own credentials, not a module boundary.
- ai-service can be scaled, sandboxed or swapped independently.
- Three things to deploy instead of one. Acceptable given serverless hosting
  (ADR-0008).

## Alternatives considered

- **Single modular monolith.** Rejected: AI code would share a process and
  database pool with payment code, which makes ADR-0007 a convention instead of
  an enforced boundary.
- **Microservice per capability** (matching, duplicates, vendors, ...).
  Rejected: these are pure functions over the same tables and gain nothing from
  a network hop.
