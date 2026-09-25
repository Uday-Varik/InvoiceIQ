# InvoiceIQ

**Accounts-payable automation where the AI can slow a payment down but can
never speed one up.**

InvoiceIQ is a multi-tenant AP automation SaaS. Invoices come in, fields are
extracted, and a **payment-safety control layer** decides whether each invoice
can move toward payment: three-way match, duplicate detection, vendor
bank-detail-change quarantine and a hash-chained audit ledger. Models help with
extraction and risk signals, but every AI output is structurally limited to
putting an invoice on HOLD.

> Status: **Phase 0 (foundations).** The domain model, contracts, guardrails,
> data tooling and design docs are in place and tested. Persistence, the review
> UI and live model calls start in Phase 1.

## The problem

AP fraud is mostly boring: the same invoice paid twice, a vendor's bank account
quietly swapped after a phishing email, a price nudged a few percent over the
PO. Adding an LLM to the pipeline adds a new one: a PDF that tells the model to
approve it. InvoiceIQ treats the model as an untrusted advisor and puts
deterministic, auditable controls between every document and the money.

## Architecture at a glance

| Deployable | Stack | Role |
| --- | --- | --- |
| `apps/web` | Next.js, React, TypeScript | Reviewer UI (Phase 0: shell reading the contract catalog) |
| `services/core-api` | TypeScript, Fastify | Owns money tables, the lifecycle gate and the audit ledger |
| `services/ai-service` | Python, FastAPI | Extraction and HOLD-only signals; no database credentials |
| Postgres | 16 | System of record, queue and outbox, row-level security |

See [C4 context](docs/c4/context.md) and [containers](docs/c4/containers.md).

### How "AI can only HOLD" is enforced

The rule is enforced in five independent places, each with its own tests
([ADR-0007](docs/adr/0007-ai-no-payment-authority.md)):

1. **Types.** AI reason codes have `allowedOutcomes: readonly ['HOLD']`. A
   catalog entry letting an AI code reject or approve does not compile.
2. **Lifecycle gate.** `evaluateTransition` refuses any AI transition except
   into HOLD, and any non-HOLD transition citing an AI reason. A seeded random
   walk of 200 AI-driven invoices never reaches APPROVED, PAYMENT_QUEUED or PAID.
3. **Contract.** `Signal.outcome` is `const: HOLD` in OpenAPI, Zod and Pydantic.
4. **Imports.** import-linter forbids database drivers in ai-service; the tests
   prove the rule fires on a probe package.
5. **Routes.** ai-service fails a test if it exposes anything that looks like
   approve, release, payment or state.

## Phase 0 deliverables

Each deliverable is labelled honestly: **Verified-in-sandbox** means it ran and
passed in the environment that produced this repo; **Written-unverified** means
it is written but could not be executed there (no Docker daemon, no cloud).

| # | Deliverable | Label | Where |
| --- | --- | --- | --- |
| 1 | Monorepo scaffolding (pnpm + uv workspaces) | Verified-in-sandbox | `package.json`, `pyproject.toml` |
| 2 | Domain model: 14 states, 18 reason codes, Zod policy | Verified-in-sandbox | `services/core-api/src/domain/` |
| 3 | OpenAPI 3.1 contracts with generated TS, Zod and Pydantic, drift-checked | Verified-in-sandbox | `packages/contracts/` |
| 4 | ai-service skeleton with import-linter money-table rule | Verified-in-sandbox | `services/ai-service/` |
| 5 | Synthetic-data tooling: labels, 61-variant taxonomy, splits, frozen manifest | Verified-in-sandbox | `data/` |
| 6 | 13 ADRs | Verified-in-sandbox | [docs/adr/README.md](docs/adr/README.md) |
| 7 | Threat model: 26 threats, 8 abuse cases | Verified-in-sandbox | [docs/threat-model/README.md](docs/threat-model/README.md) |
| 8 | CI with SHA-pinned actions and Dependabot | Verified-in-sandbox | `.github/` |
| 9 | Guardrail tests (lint rules fire; code, contracts and docs agree) | Verified-in-sandbox | `tests/guardrails/` |
| 10 | `make check` as the single gate | Verified-in-sandbox | `Makefile` |
| 11 | README, CONTRIBUTING, SECURITY | Verified-in-sandbox | this file, [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) |
| 12 | docker-compose `db` service; app services as placeholders (W-UNV) | Written-unverified | `docker-compose.yml`, `infra/` |

"Verified" for docs means the guardrail tests parse them and check them
against the code.

## Getting started

```bash
corepack enable          # pnpm 10
make install             # pnpm install + uv sync
make check               # lint, types, OpenAPI lint, drift checks, all tests
```

More in [docs/runbooks/local-development.md](docs/runbooks/local-development.md).

## Repository map

```
apps/web                 Next.js reviewer UI (shell)
services/core-api        Fastify API + pure domain model
services/ai-service      FastAPI extraction and signals
packages/contracts       OpenAPI specs, generated TS/Zod/Pydantic, reason catalog
data/                    Synthetic labels, red-team taxonomy, splits, frozen sets
evals/                   Evaluation harness (Phase 2)
infra/                   Local DB bootstrap, hosting sketches (unverified)
docs/                    ADRs, C4, threat model, runbooks, domain model
tests/guardrails         Cross-cutting drift and architecture tests
```

## Roadmap

| Phase | Focus |
| --- | --- |
| 0 | Foundations: domain model, contracts, guardrails, data tooling, docs |
| 1 | Persistence with RLS, queue and outbox, invoice intake, review queue UI |
| 2 | Real extraction behind record/replay, evaluation harness on the frozen set |
| 3 | Approvals workflow, payment runs, external anchoring of the audit chain |
| 4 | Hosting on serverless free tiers, Terraform, observability |

## License

MIT
