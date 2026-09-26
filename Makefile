# InvoiceIQ: `make check` is the single gate. CI runs exactly this.
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := check

PNPM ?= pnpm
UV ?= uv
PY_SRC := services/ai-service/src services/ai-service/tests data/src data/tests evals/src evals/tests packages/contracts/scripts tests/guardrails

.PHONY: install install-ts install-py check check-ts check-py lint-ts typecheck-ts test-ts openapi-lint \
        contracts-verify contracts-verify-py lint-py typecheck-py test-py arch-py data-check contracts data fmt clean \
        test-db up smoke down

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
	$(UV) run --frozen pytest services/ai-service/tests data/tests evals/tests tests/guardrails

## ---- local stack ----------------------------------------------------------
# core-api's Postgres integration tests run inside `make check` whenever
# TEST_DATABASE_URL is set (CI always sets it). `make test-db` makes it explicit.
DB_PORT ?= 5432
TEST_DATABASE_URL ?= postgres://invoiceiq:invoiceiq-local-only@localhost:$(DB_PORT)/invoiceiq

test-db:
	TEST_DATABASE_URL=$(TEST_DATABASE_URL) REQUIRE_DB_TESTS=1 $(PNPM) --filter @invoiceiq/core-api run test

up:
	docker compose up --build --detach --wait

smoke:
	./scripts/smoke.sh

down:
	docker compose down

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
