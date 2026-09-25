from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_service.extraction import ExtractionError, extract
from ai_service.providers import (
    Completion,
    HeuristicProvider,
    LLMProvider,
    ProviderError,
    RecordingProvider,
    ReplayMissError,
    ReplayProvider,
    request_key,
)
from invoiceiq_contracts.ai_service import ExtractionRequest

from .conftest import INVOICE_TEXT, SHA, TENANT

FIXTURES = Path(__file__).parent / "fixtures" / "replay"


class _Static:
    name = "static"

    def __init__(self, text: str) -> None:
        self.text = text

    def complete(self, *, task: str, prompt: str) -> Completion:
        return Completion(provider=self.name, model="m", text=self.text)


def _req(text: str = INVOICE_TEXT) -> ExtractionRequest:
    return ExtractionRequest.model_validate({"tenantId": TENANT, "documentSha256": SHA, "text": text})


def test_request_key_is_stable_and_input_sensitive() -> None:
    a = request_key(task="t", prompt="p")
    assert a == request_key(task="t", prompt="p")
    assert a != request_key(task="t", prompt="q")
    assert a != request_key(task="u", prompt="p")
    assert len(a) == 64


@pytest.mark.parametrize("provider", [HeuristicProvider(), ReplayProvider(FIXTURES)])
def test_providers_satisfy_protocol(provider: LLMProvider) -> None:
    assert isinstance(provider, LLMProvider)


def test_record_then_replay_is_identical(tmp_path: Path) -> None:
    live = extract(_req(), RecordingProvider(HeuristicProvider(), tmp_path))
    replayed = extract(_req(), ReplayProvider(tmp_path))
    assert replayed.fields == live.fields
    assert replayed.provider == "heuristic"
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_committed_fixture_replays() -> None:
    result = extract(_req(), ReplayProvider(FIXTURES))
    assert result.fields.invoiceNumber.value == "INV-2026-0042"


def test_replay_miss_raises() -> None:
    with pytest.raises(ReplayMissError):
        ReplayProvider(FIXTURES).complete(task="extract_invoice_fields", prompt="never recorded")


def test_replay_rejects_mismatched_key(tmp_path: Path) -> None:
    key = request_key(task="t", prompt="p")
    (tmp_path / f"{key}.json").write_text(
        json.dumps({"key": "0" * 64, "provider": "x", "model": "m", "text": "{}"})
    )
    with pytest.raises(ProviderError):
        ReplayProvider(tmp_path).complete(task="t", prompt="p")


def test_heuristic_reports_zero_confidence_for_missing_fields() -> None:
    result = extract(_req("nothing useful here"), HeuristicProvider())
    assert result.fields.totalMinor.value is None
    assert result.fields.totalMinor.confidence == 0.0


@pytest.mark.parametrize(
    ("text", "expected"),
    [("Total: 0.99", "99"), ("Amount due: 12,000.00", "1200000"), ("TOTAL # 5.05", "505")],
)
def test_heuristic_total_to_minor_units(text: str, expected: str) -> None:
    assert extract(_req(text), HeuristicProvider()).fields.totalMinor.value == expected


def test_non_json_output_is_an_extraction_error() -> None:
    with pytest.raises(ExtractionError):
        extract(_req(), _Static("not json"))


def test_non_object_output_is_an_extraction_error() -> None:
    with pytest.raises(ExtractionError):
        extract(_req(), _Static("[1, 2]"))


def test_model_cannot_inject_extra_fields_or_bad_confidence() -> None:
    text = json.dumps(
        {
            "totalMinor": {"value": "100", "confidence": 7},
            "approve": True,
            "vendorName": "not-an-object",
        }
    )
    result = extract(_req(), _Static(text))
    assert result.fields.totalMinor.confidence == 0.0
    assert result.fields.vendorName.value is None
    assert "approve" not in result.model_dump()
