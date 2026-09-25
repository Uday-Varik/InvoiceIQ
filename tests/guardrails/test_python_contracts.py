"""Python-side drift guardrails: ai-service routes, generated models and catalog agree."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from fastapi.routing import APIRoute

from ai_service.api import create_app
from ai_service.providers import HeuristicProvider
from invoiceiq_contracts import ai_service as ai_models
from invoiceiq_contracts import core_api as core_models

ROOT = Path(__file__).resolve().parents[2]
AI_SPEC: dict[str, Any] = yaml.safe_load((ROOT / "packages/contracts/openapi/ai-service.yaml").read_text())
CORE_SPEC: dict[str, Any] = yaml.safe_load((ROOT / "packages/contracts/openapi/core-api.yaml").read_text())
CATALOG: dict[str, Any] = json.loads((ROOT / "packages/contracts/catalog/reason-codes.json").read_text())


def _phase0_ops(spec: dict[str, Any]) -> set[str]:
    return {
        f"{method.upper()} {path}"
        for path, item in spec["paths"].items()
        for method, op in item.items()
        if isinstance(op, dict) and op.get("x-phase") == 0
    }


def test_ai_service_routes_equal_phase0_contract() -> None:
    app = create_app(HeuristicProvider())
    routes = {
        f"{method} {r.path}"
        for r in app.routes
        if isinstance(r, APIRoute)
        for method in (r.methods or set())
        if method != "HEAD"
    }
    assert routes == _phase0_ops(AI_SPEC)


def test_generated_ai_reason_enum_matches_catalog() -> None:
    ai_codes = [c for c, r in CATALOG["reasonCodes"].items() if r["source"] == "ai"]
    assert [c.value for c in ai_models.AiReasonCode] == ai_codes


def test_generated_core_enums_match_catalog() -> None:
    assert [s.value for s in core_models.InvoiceState] == CATALOG["states"]
    assert [c.value for c in core_models.ReasonCode] == list(CATALOG["reasonCodes"])


def test_catalog_ai_codes_are_hold_only() -> None:
    for code, r in CATALOG["reasonCodes"].items():
        if r["source"] == "ai":
            assert r["allowedOutcomes"] == ["HOLD"], code
        assert code.startswith("AI_") == (r["source"] == "ai"), code


def test_catalog_transitions_cover_every_state() -> None:
    assert set(CATALOG["transitions"]) == set(CATALOG["states"])
    for targets in CATALOG["transitions"].values():
        assert set(targets) <= set(CATALOG["states"])


def test_core_spec_money_is_string() -> None:
    money = CORE_SPEC["components"]["schemas"]["Money"]["properties"]["amountMinor"]
    assert money["type"] == "string"
