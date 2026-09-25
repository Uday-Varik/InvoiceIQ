"""Architecture guardrails for ai-service.

The import-linter contracts in pyproject.toml are only worth something if they
actually fire, so each one is run against a probe package that deliberately
breaks it. The AST and SQL scans cover rules import-linter cannot express.
"""

from __future__ import annotations

import ast
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

SERVICE = Path(__file__).resolve().parents[1]
SRC = SERVICE / "src" / "ai_service"
LINT_IMPORTS = shutil.which("lint-imports") or str(Path(sys.executable).parent / "lint-imports")

MONEY_TABLES = (
    "payments",
    "payment_batches",
    "payment_instructions",
    "vendor_bank_accounts",
    "audit_ledger",
    "invoices",
    "approvals",
)
SQL_ON_TABLE = re.compile(
    r"\b(from|into|update|join|table)\s+\"?(" + "|".join(MONEY_TABLES) + r")\b",
    re.IGNORECASE,
)


def _run_lint(config: Path, cwd: Path, contract: str | None = None) -> subprocess.CompletedProcess[str]:
    argv = [LINT_IMPORTS, "--config", str(config), "--no-cache"]
    if contract:
        argv += ["--contract", contract]
    env = {**os.environ, "PYTHONPATH": str(cwd)}
    return subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, check=False)  # noqa: S603


def _probe(tmp_path: Path, files: dict[str, str]) -> Path:
    """Build a fake `ai_service` package with the real layer skeleton plus `files`."""
    skeleton = {
        "ai_service/__init__.py": "",
        "ai_service/api/__init__.py": "",
        "ai_service/extraction.py": "",
        "ai_service/signals.py": "",
        "ai_service/providers/__init__.py": "",
    }
    for rel, body in {**skeleton, **files}.items():
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    config = tmp_path / "importlinter.toml"
    shutil.copy(SERVICE / "pyproject.toml", config)
    return config


def test_real_package_keeps_all_contracts() -> None:
    result = _run_lint(SERVICE / "pyproject.toml", SERVICE / "src")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "0 broken" in result.stdout


@pytest.mark.parametrize("driver", ["sqlalchemy", "psycopg", "asyncpg", "sqlite3"])
def test_no_money_db_contract_fires(tmp_path: Path, driver: str) -> None:
    config = _probe(tmp_path, {"ai_service/sneaky.py": f"import {driver}\n"})
    result = _run_lint(config, tmp_path, "no-money-db")
    assert result.returncode != 0, result.stdout
    assert "BROKEN" in result.stdout


def test_layers_contract_fires(tmp_path: Path) -> None:
    config = _probe(tmp_path, {"ai_service/providers/__init__.py": "import ai_service.signals\n"})
    result = _run_lint(config, tmp_path, "layers")
    assert result.returncode != 0, result.stdout
    assert "BROKEN" in result.stdout


def test_contract_ids_are_the_documented_ones() -> None:
    config = tomllib.loads((SERVICE / "pyproject.toml").read_text())
    ids = [c["id"] for c in config["tool"]["importlinter"]["contracts"]]
    assert ids == ["no-money-db", "layers"]


def _python_sources() -> list[Path]:
    return sorted(SRC.rglob("*.py"))


@pytest.mark.parametrize("path", _python_sources(), ids=lambda p: str(p.relative_to(SRC)))
def test_never_imports_core_api_models(path: Path) -> None:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            assert not node.module.startswith("invoiceiq_contracts.core_api"), path
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert not alias.name.startswith("invoiceiq_contracts.core_api"), path


@pytest.mark.parametrize("path", _python_sources(), ids=lambda p: str(p.relative_to(SRC)))
def test_no_sql_against_money_tables(path: Path) -> None:
    assert SQL_ON_TABLE.search(path.read_text()) is None, path


@pytest.mark.parametrize("path", _python_sources(), ids=lambda p: str(p.relative_to(SRC)))
def test_no_database_url_in_config(path: Path) -> None:
    assert "DATABASE_URL" not in path.read_text(), path


@pytest.mark.parametrize(
    "sql",
    ["SELECT * FROM payments", "insert into vendor_bank_accounts values (1)", 'UPDATE "invoices" SET x=1'],
)
def test_sql_scanner_detects_money_tables(sql: str) -> None:
    assert SQL_ON_TABLE.search(sql) is not None
