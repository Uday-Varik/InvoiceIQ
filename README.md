# InvoiceIQ

**Accounts-payable automation where the AI can slow a payment down but can
never speed one up.**

InvoiceIQ is a multi-tenant AP automation SaaS. Invoices come in, fields are
extracted, and a **payment-safety control layer** decides whether each invoice
can move toward payment: three-way match, duplicate detection, vendor
bank-detail-change quarantine and a hash-chained audit ledger. Models help with
extraction and risk signals, but every AI output is structurally limited to
putting an invoice on HOLD.

> Status: **Phase 3 (controls).** On top of Phase 2's extraction, review,
> correction and export: tiered approvals with separation of duties, vendor
> bank-change quarantine with four-eyes verification, payment runs confirmed
> by a second person with a generated payment file, and Ed25519-signed audit
> checkpoints. Live model calls and hosting come later.

## The problem

AP fraud is mostly boring: the same invoice paid twice, a vendor's bank account
quietly swapped after a phishing email, a price nudged a few percent over the
PO. Adding an LLM to the pipeline adds a new one: a PDF that tells the model to
approve it. InvoiceIQ treats the model as an untrusted advisor and puts
deterministic, auditable controls between every document and the money.

## Architecture at a glance

| Deployable | Stack | Role |
| --- | --- | --- |
| `apps/web` | Next.js, React, TypeScript | Upload and review UI; talks to core-api through a same-origin proxy |
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

## Phase 1 deliverables

Same labels as above. The Dockerfiles were built and run in the sandbox with
its egress proxy's CA injected at build time (the committed files do not
contain it); CI builds them unmodified.

| # | Deliverable | Label | Where |
| --- | --- | --- | --- |
| 1 | Postgres migrations, tenant bootstrap, RLS enabled and forced on every table | Verified-in-sandbox | `services/core-api/migrations/`, `src/db/` |
| 2 | Invoice API: upload, list, get, document, approve, reject, transitions, audit verify | Verified-in-sandbox | `services/core-api/src/http/app.ts` |
| 3 | Every state change through the gate, with audit entry and outbox event in one transaction | Verified-in-sandbox | `services/core-api/src/invoices/lifecycle.ts` |
| 4 | OIDC/JWT auth, plus an explicit open demo mode | Verified-in-sandbox | `services/core-api/src/auth/auth.ts` |
| 5 | Wake-and-drain outbox relay: leases, backoff, dead-letter to HOLD | Verified-in-sandbox | `services/core-api/src/outbox/worker.ts` |
| 6 | Integration tests on real Postgres (RLS, API, auth, worker, migrations) | Verified-in-sandbox | `services/core-api/test/integration/` |
| 7 | ai-service baseline PDF extraction and HMAC-signed calls from core-api | Verified-in-sandbox | `services/ai-service/src/ai_service/` |
| 8 | Web upload, review with confidence, approve/reject, "Waking the demo" | Verified-in-sandbox | `apps/web/` |
| 9 | Dockerfiles for core-api and ai-service (multi-stage, non-root, health checks) | Verified-in-sandbox | `services/*/Dockerfile` |
| 10 | Docker compose stack and end-to-end smoke script | Verified-in-sandbox | `docker-compose.yml`, `scripts/smoke.sh` |
| 11 | Render blueprint and Vercel config for the free-tier deploy (W-UNV) | Written-unverified | `render.yaml`, `apps/web/vercel.json` |
| 12 | Neon, Render and Vercel deploy runbook (W-UNV) | Written-unverified | [docs/runbooks/deploy-free-tier.md](docs/runbooks/deploy-free-tier.md) |

## Phase 2 deliverables

Same labels as above.

| # | Deliverable | Label | Where |
| --- | --- | --- | --- |
| 1 | Extraction of subtotal, tax, due date and line items, with cross-checked confidence | Verified-in-sandbox | `services/ai-service/src/ai_service/providers/heuristic.py` |
| 2 | Line items and invoice details in Postgres, RLS forced | Verified-in-sandbox | `services/core-api/migrations/0002_invoice_details.sql` |
| 3 | Deterministic totals check (subtotal + tax, lines + tax) routing to EXCEPTION | Verified-in-sandbox | `services/core-api/src/invoices/pipeline.ts` |
| 4 | Paginated list with search, state, currency, date and amount filters, plus summary | Verified-in-sandbox | `services/core-api/src/invoices/filters.ts` |
| 5 | Edit-before-approve: versioned, idempotent, audited, re-validated | Verified-in-sandbox | `services/core-api/src/invoices/corrections.ts` |
| 6 | CSV and JSON export of the filtered list, formula-injection safe | Verified-in-sandbox | `services/core-api/src/invoices/export.ts` |
| 7 | Web dashboard, correction form and change history | Verified-in-sandbox | `apps/web/components/` |
| 8 | Smoke script covers line items, correction, search, export and summary | Verified-in-sandbox | `scripts/smoke.sh` |

## Phase 3 deliverables

Same labels as above. Decisions in [ADR-0016](docs/adr/0016-phase-3-approvals-bank-changes-payment-runs-checkpoints.md).

| # | Deliverable | Label | Where |
| --- | --- | --- | --- |
| 1 | Vendors, bank changes, payment runs, approvals and checkpoints in Postgres, RLS forced | Verified-in-sandbox | `services/core-api/migrations/0003_approvals_vendors_payments.sql` |
| 2 | Tiered approvals: role limits, N distinct approvers, no self or corrector approval | Verified-in-sandbox | `services/core-api/src/domain/approvals.ts` |
| 3 | Bank-change quarantine with four-eyes callback verification | Verified-in-sandbox | `services/core-api/src/vendors/service.ts` |
| 4 | Payment runs: assemble, second-person confirm, cancel, payment file | Verified-in-sandbox | `services/core-api/src/payments/service.ts` |
| 5 | Ed25519-signed audit checkpoints, verified against the chain and external copies | Verified-in-sandbox | `services/core-api/src/audit/checkpoints.ts` |
| 6 | Demo personas for exercising separation of duties without an identity provider | Verified-in-sandbox | `services/core-api/src/auth/auth.ts` |
| 7 | Web pages for vendors, payment runs, audit checkpoints and approval progress | Verified-in-sandbox | `apps/web/components/payments.tsx` |
| 8 | Smoke script covers two-person approval, a payment run and a checkpoint | Verified-in-sandbox | `scripts/smoke.sh` |

## Getting started

```bash
corepack enable          # pnpm 10
make install             # pnpm install + uv sync
make check               # lint, types, OpenAPI lint, drift checks, all tests
```

Run it:

```bash
make up                                   # Postgres, ai-service, core-api in Docker
make smoke                                # upload -> extract -> approve -> verify audit
CORE_API_URL=http://localhost:3001 pnpm --filter @invoiceiq/web dev
```

More in [docs/runbooks/local-development.md](docs/runbooks/local-development.md).

## Repository map

```
apps/web                 Next.js upload, review, dashboard, vendors, payments and audit UI
services/core-api        Fastify API + pure domain model
services/ai-service      FastAPI extraction and signals
packages/contracts       OpenAPI specs, generated TS/Zod/Pydantic, reason catalog
data/                    Synthetic labels, red-team taxonomy, splits, frozen sets
evals/                   Evaluation harness (Phase 2)
infra/                   Local DB bootstrap, hosting sketches (unverified)
scripts/                 End-to-end smoke test
docs/                    ADRs, C4, threat model, runbooks, domain model
tests/guardrails         Cross-cutting drift and architecture tests
```

## Roadmap

| Phase | Focus |
| --- | --- |
| 0 | Foundations: domain model, contracts, guardrails, data tooling, docs |
| 1 | Persistence with RLS, queue and outbox, invoice intake, review queue UI |
| 2 | Real extraction behind record/replay, evaluation harness on the frozen set |
| 3 | Approvals workflow, payment runs, external anchoring of the audit chain (done) |
| 4 | Hosting on serverless free tiers, Terraform, observability |

## License

MIT
