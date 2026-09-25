# Contributing to InvoiceIQ

InvoiceIQ decides whether money moves. Contributions are welcome, and the bar
for anything touching the payment path is high.

## Ground rules

1. **`make check` is the gate.** It must pass locally before you open a PR,
   and CI runs exactly the same targets.
2. **AI never gets payment authority** ([ADR-0007](docs/adr/0007-ai-no-payment-authority.md)).
   A change that lets any AI-derived signal do more than HOLD will be declined,
   however it is configured.
3. **Contracts first** ([ADR-0012](docs/adr/0012-contract-first-generated-code.md)).
   Change the OpenAPI YAML, run `make contracts`, commit the generated files.
4. **Money is integers** ([ADR-0013](docs/adr/0013-money-integer-minor-units.md)).
   No floats for amounts, anywhere.
5. **Decisions get ADRs.** If you pick a library, reject an approach or change
   a trust boundary, add an ADR and a row in `docs/adr/README.md`.
6. **New attack ideas go in the taxonomy.** Add a variant to
   `data/redteam/taxonomy.yaml` and update the expected count in the same PR.

## Workflow

```bash
make install
git switch -c your-change
# edit
make contracts data   # if you touched OpenAPI, the reason catalog or data
make check
```

Open a PR against `main` and fill in the template's safety checklist.

## Code style

- TypeScript: strict mode, ESLint (`typescript-eslint` strict), no default
  exports outside config files, domain code is pure (no I/O, no framework).
- Python: ruff (lint and format), mypy `--strict`, Pydantic v2.
- Tests sit next to the code they cover (`test/` or `tests/`). Cross-cutting
  checks go in `tests/guardrails/`.

## Commit messages

Imperative mood, under 72 characters in the subject, body explaining why.
