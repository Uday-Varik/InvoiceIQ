# evals

Offline evaluation harness (Phase 2). It will score extraction and signals
against the frozen, tamper-evident test set in `data/frozen/test-v1/` using
replayed model outputs (ADR-0006), and report per red-team category:

- detection rate (did every expected reason code fire?),
- outcome correctness (did the gate land in the expected state?),
- false-hold rate on clean documents.

Phase 0 ships the inputs: label schema, 61-variant taxonomy, family-safe
splits and the frozen manifest (see `data/`).
