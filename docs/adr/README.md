# Architecture decision records

Each ADR records one decision, its context and what it costs. ADRs are
immutable once accepted; a reversal is a new ADR that supersedes the old one.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-monorepo.md) | One monorepo with pnpm and uv workspaces | Accepted |
| [0002](0002-three-deployables.md) | Three deployables plus Postgres | Accepted |
| [0003](0003-postgres-queue-outbox.md) | Postgres as the job queue and transactional outbox (Kafka rejected) | Accepted |
| [0004](0004-rls-multi-tenancy.md) | Multi-tenancy with Postgres row-level security | Accepted |
| [0005](0005-fastify-and-fastapi.md) | Fastify for core-api, FastAPI for ai-service | Accepted |
| [0006](0006-llm-provider-record-replay.md) | LLM provider abstraction with record/replay | Accepted |
| [0007](0007-ai-no-payment-authority.md) | AI holds no payment authority | Accepted |
| [0008](0008-serverless-free-tier-hosting.md) | Serverless free-tier hosting | Accepted |
| [0009](0009-hash-chained-audit-log.md) | Hash-chained, append-only audit log | Accepted |
| [0010](0010-lexical-first-retrieval.md) | Lexical-first retrieval | Accepted |
| [0011](0011-typescript-5-pin.md) | Pin TypeScript to 5.x | Accepted |
| [0012](0012-contract-first-generated-code.md) | Contract-first OpenAPI 3.1 with committed, drift-checked generated code | Accepted |
| [0013](0013-money-integer-minor-units.md) | Money as integer minor units | Accepted |
| [0014](0014-phase-1-runtime.md) | Phase 1 runtime: in-process outbox relay, signed service calls, documents in Postgres | Accepted |
| [0015](0015-phase-2-invoice-details-corrections-export.md) | Phase 2: line items in Postgres, edit-before-approve re-validates, filtered export | Accepted |

## Writing a new ADR

Copy the structure of an existing one (Status, Date, Context, Decision,
Consequences, Alternatives considered), take the next number, and add a row
here. `tests/guardrails/docs-drift.test.ts` fails if this index and the files
disagree.
