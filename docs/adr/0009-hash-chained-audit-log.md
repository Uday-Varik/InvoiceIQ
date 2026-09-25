# ADR-0009: Hash-chained, append-only audit log

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

AP fraud investigations ask who changed what, when, and whether the record was
altered afterwards. A normal audit table can be edited by anyone with write
access to it, including a compromised application.

## Decision

- Every state change, approval, hold, release and vendor bank change appends an
  entry to `audit_ledger` in the same transaction as the change (ADR-0003).
- Each entry stores `seq`, `prev_hash` and
  `hash = sha256(canonical_json({seq, prevHash, event}))`, chained per tenant
  from a genesis hash of 64 zeros.
- Canonical JSON (sorted keys, no whitespace, bigint as decimal strings) is
  defined once in `services/core-api/src/domain/audit-ledger.ts`.
- The app role has `INSERT` and `SELECT` only; `UPDATE`, `DELETE` and
  `TRUNCATE` are revoked and blocked by trigger.
- `GET /v1/audit/verify` recomputes the chain. The latest hash is periodically
  anchored outside the database (Phase 3).

## Consequences

- Any edit, deletion or reordering breaks verification at the first affected
  entry (tested).
- A full rewrite by a database superuser is only detectable against an external
  anchor, which is why anchoring is on the roadmap.
- Appends serialize per tenant. Fine at expected volume.

## Alternatives considered

- **Managed ledger database.** Rejected: vendor lock-in and cost.
- **Signed entries only.** Detects edits but not deletions; chaining covers both.
