from __future__ import annotations

import pytest
from pydantic import ValidationError

from ai_service.signals import MONEY_BEARING_FIELDS, compute_signals, hold_signal
from invoiceiq_contracts.ai_service import (
    AiReasonCode,
    ExtractedField,
    ExtractionResult,
    Fields,
    Flag,
    RiskFlag,
    Signal,
    SignalRequest,
)

from .conftest import SHA


def _extraction(**overrides: float) -> ExtractionResult:
    fields = {
        name: ExtractedField(value="x", confidence=overrides.get(name, 0.99))
        for name in (
            "vendorName",
            "invoiceNumber",
            "invoiceDate",
            "currency",
            "totalMinor",
            "subtotalMinor",
            "taxMinor",
            "dueDate",
        )
    }
    return ExtractionResult(documentSha256=SHA, provider="test", fields=Fields(**fields), lineItems=[])


def test_confident_extraction_emits_nothing() -> None:
    assert (
        compute_signals(SignalRequest(extraction=_extraction(), extractionConfidenceHoldBelow=0.9)).signals
        == []
    )


@pytest.mark.parametrize("field", MONEY_BEARING_FIELDS)
def test_low_confidence_money_field_holds(field: str) -> None:
    res = compute_signals(
        SignalRequest(extraction=_extraction(**{field: 0.5}), extractionConfidenceHoldBelow=0.9)
    )
    assert len(res.signals) == 1
    sig = res.signals[0]
    assert sig.reasonCode is AiReasonCode.AI_EXTRACTION_LOW_CONFIDENCE
    assert sig.outcome == "HOLD"
    assert field in sig.evidence
    assert sig.score == pytest.approx(0.5)


def test_low_confidence_date_alone_does_not_hold() -> None:
    res = compute_signals(
        SignalRequest(extraction=_extraction(invoiceDate=0.1), extractionConfidenceHoldBelow=0.9)
    )
    assert res.signals == []


def test_missing_value_holds_even_with_high_confidence() -> None:
    ex = _extraction()
    ex.fields.totalMinor = ExtractedField(value=None, confidence=0.99)
    res = compute_signals(SignalRequest(extraction=ex, extractionConfidenceHoldBelow=0.9))
    assert len(res.signals) == 1


@pytest.mark.parametrize("code", list(AiReasonCode))
def test_hold_signal_is_always_hold(code: AiReasonCode) -> None:
    assert hold_signal(code, 2.0, "e").outcome == "HOLD"
    assert hold_signal(code, 2.0, "e").score == 1.0
    assert hold_signal(code, -1.0, "e").score == 0.0


@pytest.mark.parametrize("outcome", ["APPROVED", "REJECTED", "EXCEPTION", "RELEASE", "hold"])
def test_contract_model_rejects_non_hold_outcomes(outcome: str) -> None:
    with pytest.raises(ValidationError):
        Signal.model_validate(
            {"reasonCode": "AI_ANOMALY_SUSPECTED", "outcome": outcome, "score": 0.5, "evidence": ""}
        )


@pytest.mark.parametrize("code", ["DUPLICATE_EXACT", "VENDOR_BANK_CHANGE_QUARANTINE", "APPROVED"])
def test_contract_model_rejects_non_ai_codes(code: str) -> None:
    with pytest.raises(ValidationError):
        Signal.model_validate({"reasonCode": code, "outcome": "HOLD", "score": 0.5, "evidence": ""})


def test_evidence_is_truncated() -> None:
    assert len(hold_signal(AiReasonCode.AI_ANOMALY_SUSPECTED, 0.5, "x" * 5000).evidence) == 2000


# ---- risk flag signals -------------------------------------------------------


def _extraction_with_flags(*flags: RiskFlag) -> ExtractionResult:
    fields = {
        name: ExtractedField(value="x", confidence=0.99)
        for name in (
            "vendorName", "invoiceNumber", "invoiceDate", "currency",
            "totalMinor", "subtotalMinor", "taxMinor", "dueDate",
        )
    }
    return ExtractionResult(
        documentSha256=SHA, provider="test", fields=Fields(**fields),
        lineItems=[], riskFlags=list(flags) or None,
    )


@pytest.mark.parametrize(
    ("flag", "expected_code"),
    [
        (Flag.anomaly_suspected, AiReasonCode.AI_ANOMALY_SUSPECTED),
        (Flag.document_tampering, AiReasonCode.AI_DOCUMENT_TAMPERING_SUSPECTED),
        (Flag.semantic_duplicate, AiReasonCode.AI_SEMANTIC_DUPLICATE_SUSPECTED),
    ],
)
def test_risk_flag_above_threshold_fires_signal(flag: Flag, expected_code: AiReasonCode) -> None:
    rf = RiskFlag(flag=flag, score=0.8, evidence="test evidence")
    ex = _extraction_with_flags(rf)
    res = compute_signals(SignalRequest(extraction=ex, extractionConfidenceHoldBelow=0.9))
    codes = [s.reasonCode for s in res.signals]
    assert expected_code in codes
    sig = next(s for s in res.signals if s.reasonCode == expected_code)
    assert sig.outcome == "HOLD"
    assert sig.score == pytest.approx(0.8)
    assert sig.evidence == "test evidence"


def test_risk_flag_below_threshold_does_not_fire() -> None:
    rf = RiskFlag(flag=Flag.anomaly_suspected, score=0.3, evidence="weak signal")
    ex = _extraction_with_flags(rf)
    res = compute_signals(SignalRequest(extraction=ex, extractionConfidenceHoldBelow=0.9))
    codes = [s.reasonCode for s in res.signals]
    assert AiReasonCode.AI_ANOMALY_SUSPECTED not in codes


def test_multiple_risk_flags_fire_multiple_signals() -> None:
    flags = [
        RiskFlag(flag=Flag.anomaly_suspected, score=0.9, evidence="urgency"),
        RiskFlag(flag=Flag.document_tampering, score=0.7, evidence="metadata"),
    ]
    ex = _extraction_with_flags(*flags)
    res = compute_signals(SignalRequest(extraction=ex, extractionConfidenceHoldBelow=0.9))
    codes = {s.reasonCode for s in res.signals}
    assert AiReasonCode.AI_ANOMALY_SUSPECTED in codes
    assert AiReasonCode.AI_DOCUMENT_TAMPERING_SUSPECTED in codes


def test_no_risk_flags_emits_nothing_extra() -> None:
    ex = _extraction_with_flags()
    res = compute_signals(SignalRequest(extraction=ex, extractionConfidenceHoldBelow=0.9))
    assert res.signals == []
