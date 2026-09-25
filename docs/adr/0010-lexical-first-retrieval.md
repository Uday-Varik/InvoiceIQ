# ADR-0010: Lexical-first retrieval

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Duplicate detection and vendor matching need to find similar past invoices and
vendors. Embedding search is the fashionable default but is opaque, needs a
vector store, and its false positives are hard to explain to an AP clerk.

## Decision

- Start with **lexical and rule-based retrieval**: normalized invoice numbers,
  edit distance, exact amount and date windows (see `duplicates.ts`), and
  Postgres full-text and `pg_trgm` for vendor names.
- Embeddings are added only where an evaluation on the frozen test set shows a
  measurable gain in recall at equal precision, and only as an AI signal
  (`AI_SEMANTIC_DUPLICATE_SUSPECTED`, HOLD-only per ADR-0007).

## Consequences

- Every deterministic duplicate hit is explainable in one sentence.
- No vector database in Phase 0 or 1.
- Reworded or translated duplicates are missed until the semantic signal ships;
  the red-team taxonomy tracks these as `detection: ai` variants.

## Alternatives considered

- **Embeddings first.** Rejected until evaluation justifies it.
- **External search service.** Rejected: Postgres already covers the need.
