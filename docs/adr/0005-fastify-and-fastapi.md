# ADR-0005: Fastify for core-api, FastAPI for ai-service

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

core-api is TypeScript so it can share generated contract types with the web
app. ai-service is Python because the extraction and evaluation ecosystem
lives there. Both need schema-validated request handling that can be checked
against the OpenAPI contracts.

## Decision

- **core-api:** Fastify 5. JSON-schema route validation, `inject()` for fast
  in-process HTTP tests, low overhead, no decorators.
- **ai-service:** FastAPI with Pydantic v2 models generated from the contract
  (`invoiceiq_contracts`), so request and response validation is the contract.
- The HTTP layer is thin. Domain logic in core-api lives in `src/domain/` and
  may not import Fastify (enforced by ESLint, ADR-0012 guardrails).

## Consequences

- Swapping either framework touches only the HTTP layer.
- Two frameworks to know. Both are mainstream and well documented.

## Alternatives considered

- **NestJS.** Rejected: decorator-heavy DI adds indirection we do not need.
- **Express.** Rejected: no built-in schema validation, slower, and its async
  error handling needs wrappers.
- **Flask / Django for ai-service.** Rejected: no native Pydantic validation;
  Django brings an ORM that ADR-0007 explicitly forbids.
