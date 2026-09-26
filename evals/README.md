# evals

Offline evaluation harness. It scores extraction and AI signals against the
frozen, tamper-evident test set in `data/frozen/test-v1/` and reports:

- **AI detection rate**: did every expected AI reason code fire?
- **Outcome accuracy**: did AI signals correctly hold attacks and pass clean docs?
- **False-hold rate**: how many clean documents got an AI hold signal?

Only AI-sourced signals (`AI_EXTRACTION_LOW_CONFIDENCE`, `AI_ANOMALY_SUSPECTED`,
`AI_DOCUMENT_TAMPERING_SUSPECTED`, `AI_SEMANTIC_DUPLICATE_SUSPECTED`) are
evaluated. Deterministic signals (duplicates, vendor lookup, policy) run in
core-api against a live database and are tested by integration tests there.

## Usage

```bash
uv run invoiceiq-evals              # text report
uv run invoiceiq-evals --json       # JSON report
uv run invoiceiq-evals --threshold 0.9   # custom hold threshold
```

## How it works

1. Each label in the frozen set is rendered into synthetic invoice text.
2. The `HeuristicProvider` extracts fields from that text (offline, no API keys).
3. `compute_signals` produces AI hold signals from the extraction.
4. The fired AI codes are compared against the label's expected codes.
5. Metrics are aggregated per red-team category and overall.
