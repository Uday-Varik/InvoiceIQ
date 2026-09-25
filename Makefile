# InvoiceIQ: `make check` is the single gate. CI runs exactly this.
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := check

PNPM ?= pnpm
UV ?= uv
PY_SRC := services/ai-service/src services/ai-service/tests data/src data/tests packages/contracts/scripts tests/guardrails

.PHONY: install install-ts install-py check check-ts check-py lint-ts typecheck-ts test-ts openapi-lint \
        contracts-verify contracts-verify-py lint-py typecheck-py test-py arch-py data-check contracts data fmt clean

install: install-ts install-py

install-ts:
	$(PNPM) install --frozen-lockfile

install-py:
	$(UV) sync --all-packages --frozen

## ---- the gate ---------------------------------------------------------------
check: check-ts check-py
	@echo "make check: all gates passed"

check-ts: lint-ts typecheck-ts openapi-lint contracts-verify test-ts

check-py: lint-py typecheck-py arch-py contracts-verify-py data-check test-py

## ---- TypeScript -------------------------------------------------------------
lint-ts:
	$(PNPM) run lint

typecheck-ts:
	$(PNPM) run typecheck

openapi-lint:
	$(PNPM) run openapi:lint

contracts-verify:
	$(PNPM) run contracts:verify
	$(PNPM) --filter @invoiceiq/core-api run catalog:check

test-ts:
	$(PNPM) run test

## ---- Python -----------------------------------------------------------------
lint-py:
	$(UV) run --frozen ruff check .
	$(UV) run --frozen ruff format --check .

typecheck-py:
	$(UV) run --frozen mypy $(PY_SRC)

arch-py:
	cd services/ai-service && $(UV) run --frozen lint-imports --no-cache

contracts-verify-py:
	$(UV) run --frozen python packages/contracts/scripts/generate_pydantic.py --check

data-check:
	$(UV) run --frozen invoiceiq-data check

test-py:
	$(UV) run --frozen pytest services/ai-service/tests data/tests tests/guardrails

## ---- generators -------------------------------------------------------------
contracts:
	$(PNPM) run contracts:generate
	$(PNPM) --filter @invoiceiq/core-api run catalog
	$(UV) run python packages/contracts/scripts/generate_pydantic.py

data:
	$(UV) run invoiceiq-data build

fmt:
	$(UV) run ruff format .
	$(UV) run ruff check --fix .

clean:
	rm -rf node_modules */*/node_modules .venv apps/web/.next **/*.tsbuildinfo .pytest_cache .mypy_cache .ruff_cache
