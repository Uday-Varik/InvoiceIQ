# Runbook: contract or catalog drift in CI

**Signal:** `contracts:verify`, `generate_pydantic.py --check`,
`catalog:check`, `invoiceiq-data check` or a guardrail test fails.

1. Run `make contracts data` locally and commit the regenerated files.
2. If the regenerated diff is large and you did not touch the YAML, a generator
   version changed. Put the regeneration in its own PR.
3. If a guardrail test says code, contract and `docs/architecture/domain-model.md`
   disagree, decide which one is right and change the other two in the same PR.
