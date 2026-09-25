from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from invoiceiq_data.labels import LabelRecord, label_json_schema
from invoiceiq_data.paths import LABEL_SCHEMA


def _clean(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "doc_id": "DOC-0123456789ab",
        "family_id": "FAM-01234567",
        "is_attack": False,
        "vendor_id": "VEN-0001",
        "invoice_number": "INV-1",
        "invoice_date": "2026-01-01",
        "currency": "USD",
        "total_minor": 100,
        "expected_outcome": "PASS",
    }
    return {**base, **over}


def _attack(**over: Any) -> dict[str, Any]:
    attack: dict[str, Any] = {
        "variant_id": "RT-DUP-01",
        "is_attack": True,
        "expected_reason_codes": ["DUPLICATE_EXACT"],
        "expected_outcome": "HOLD",
    }
    return _clean(**{**attack, **over})


def test_clean_and_attack_records_validate() -> None:
    assert LabelRecord.model_validate(_clean()).expected_outcome == "PASS"
    assert LabelRecord.model_validate(_attack()).is_attack


@pytest.mark.parametrize(
    "record",
    [
        _clean(is_attack=True),
        _clean(expected_outcome="HOLD"),
        _clean(expected_reason_codes=["DUPLICATE_EXACT"]),
        _attack(expected_reason_codes=[]),
        _attack(expected_outcome="PASS"),
        _attack(expected_reason_codes=["NOPE"]),
        _attack(expected_reason_codes=["AI_ANOMALY_SUSPECTED"], expected_outcome="REJECTED"),
        _clean(doc_id="doc-1"),
        _clean(total_minor=-1),
        _clean(currency="usd"),
        _clean(extra="field"),
    ],
)
def test_invalid_records_are_rejected(record: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        LabelRecord.model_validate(record)


def test_committed_schema_matches_model() -> None:
    assert LABEL_SCHEMA.read_text() == label_json_schema()


def test_schema_is_2020_12_and_closed() -> None:
    schema = json.loads(label_json_schema())
    assert schema["$schema"].endswith("2020-12/schema")
    assert schema["additionalProperties"] is False
