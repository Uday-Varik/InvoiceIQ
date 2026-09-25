# ADR-0003: Postgres as the job queue and transactional outbox (Kafka rejected)

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Invoices move through asynchronous steps (extraction, validation, matching).
Every state change must be recorded in the audit ledger and must emit events
exactly once relative to the database commit. Expected volume in the first
year is thousands of invoices per tenant per month, not millions per second.

## Decision

- Use Postgres tables as the job queue, claimed with
  `SELECT ... FOR UPDATE SKIP LOCKED`.
- Use a **transactional outbox**: the state change, the audit entry and the
  outbound event row are written in one transaction. A relay publishes outbox
  rows and marks them sent.
- Consumers are idempotent, keyed by `(tenant_id, event_id)`.

## Consequences

- No dual-write problem: an event exists if and only if its state change
  committed.
- One fewer stateful system to run, secure and pay for.
- Throughput ceiling is Postgres write throughput. Revisit above roughly 500
  jobs per second sustained.
- Queue tables need vacuum tuning and a retention job.

## Alternatives considered

- **Kafka.** Rejected: operational weight, no free tier that fits ADR-0008, and
  it still needs an outbox to avoid dual writes.
- **SQS or Cloud Tasks.** Rejected for now: reintroduces dual writes and
  couples us to one cloud. Could sit behind the outbox relay later.
- **pg-boss / graphile-worker.** Reasonable; deferred until Phase 1 picks a
  worker runtime. The table layout above is compatible with either.
