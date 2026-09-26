# ADR-0019: Offline evaluation harness for AI signals

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

The AI service produces extraction results and advisory risk signals (hold
recommendations). Until now the only way to test those signals against the
red-team taxonomy was manually: render a document, post it to the API, and
inspect the response. The frozen test set (`data/frozen/test-v1/test.jsonl`,
46 labelled documents) existed but had no automated scorer.

## Decision

- **A new `evals` workspace member** under `evals/` with its own
  `pyproject.toml`. It depends on `invoiceiq-data` (labels, taxonomy),
  `invoiceiq-contracts` (types) and `invoiceiq-ai-service` (extraction,
  signals).
- **Offline-only, no network.** The harness renders each label into
  synthetic invoice text, runs extraction through the `HeuristicProvider`
  (deterministic, no API keys), computes signals, and compares fired AI
  reason codes against the label's expected codes.
- **AI signals only.** Deterministic signals such as `DUPLICATE_EXACT` and
  `VENDOR_BANK_CHANGE_QUARANTINE` require the core-api database (prior
  invoices, vendor history). The harness filters expected codes to the
  `AiReasonCode` enum and ignores the rest.
- **Metrics.** Detection rate (did every expected AI code fire?), outcome
  accuracy (attack held or clean passed?), false-hold rate (clean docs
  incorrectly held), all broken down per taxonomy category.
- **CLI.** `invoiceiq-evals [--json] [--threshold 0.8] [--version test-v1]`
  prints a text or JSON report.

## Consequences

- The harness runs in `make check` alongside every other gate.
- Baseline with the heuristic provider: 0% AI detection rate (expected —
  it does not detect anomalies), 0% false-hold rate, ~58% outcome accuracy
  (clean docs pass but attacks are not caught).
- When an ML-backed provider is added, the same harness measures how much
  detection improves without changing the test set or the scorer.
