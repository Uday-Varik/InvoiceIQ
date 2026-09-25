# ADR-0012: Contract-first OpenAPI 3.1 with committed, drift-checked generated code

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Two languages, three deployables. Hand-written types on each side of an API
drift. Generated code that is not committed hides changes from review.

## Decision

- `packages/contracts/openapi/*.yaml` (OpenAPI 3.1) is the source of truth.
  Operations are tagged `x-phase` so contracts can lead implementation.
- From it we generate and **commit**:
  - TypeScript types (`openapi-typescript`),
  - Zod validators (`json-schema-to-zod`),
  - Pydantic v2 models (`datamodel-code-generator`), installable as
    `invoiceiq_contracts`.
- core-api exports its reason catalog and lifecycle graph to
  `packages/contracts/catalog/reason-codes.json` for Python consumers.
- CI regenerates everything and fails on any difference (`contracts:verify`,
  `generate_pydantic.py --check`, `catalog:check`).
- Guardrail tests check that implemented routes exist in the contract, that
  every `x-phase: 0` route is implemented, and that enums in code, contract and
  `docs/architecture/domain-model.md` agree.
- Specs are linted with Redocly (`recommended` plus stricter rules).

## Consequences

- A contract change shows up in review as YAML plus generated diffs.
- Generator upgrades produce noisy diffs; they are isolated in their own PRs.

## Alternatives considered

- **Code-first (generate OpenAPI from Fastify/FastAPI).** Rejected: two
  sources of truth, one per language.
- **Generate at build time, do not commit.** Rejected: reviewers cannot see
  generated changes, and the web build would need Python.
