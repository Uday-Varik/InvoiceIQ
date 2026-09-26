"""Run extraction and signals against each labelled document."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass

from ai_service.extraction import extract
from ai_service.providers import ExtractionProvider, HeuristicProvider
from ai_service.signals import compute_signals
from invoiceiq_contracts.ai_service import (
    AiReasonCode,
    ExtractionRequest,
    ExtractionResult,
    SignalRequest,
    SignalResponse,
)
from invoiceiq_data.labels import LabelRecord
from invoiceiq_evals.renderer import render

DEFAULT_HOLD_THRESHOLD = 0.8
TENANT = "00000000-0000-0000-0000-000000000000"

AI_REASON_CODES = frozenset(c.value for c in AiReasonCode)


@dataclass(frozen=True, slots=True)
class EvalResult:
    label: LabelRecord
    extraction: ExtractionResult
    signals: SignalResponse
    fired_ai_codes: frozenset[str]
    expected_ai_codes: frozenset[str]


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def evaluate_one(
    label: LabelRecord,
    provider: ExtractionProvider | None = None,
    hold_threshold: float = DEFAULT_HOLD_THRESHOLD,
) -> EvalResult:
    provider = provider or HeuristicProvider()
    text = render(label)
    sha = _sha256(text)
    extraction = extract(
        ExtractionRequest(tenantId=TENANT, documentSha256=sha, text=text),
        provider,
    )
    signal_response = compute_signals(
        SignalRequest(extraction=extraction, extractionConfidenceHoldBelow=hold_threshold)
    )
    fired = frozenset(s.reasonCode.value for s in signal_response.signals)
    expected = frozenset(c for c in label.expected_reason_codes if c in AI_REASON_CODES)
    return EvalResult(
        label=label,
        extraction=extraction,
        signals=signal_response,
        fired_ai_codes=fired,
        expected_ai_codes=expected,
    )


def evaluate_all(
    labels: Sequence[LabelRecord],
    hold_threshold: float = DEFAULT_HOLD_THRESHOLD,
    provider: ExtractionProvider | None = None,
) -> list[EvalResult]:
    active = provider or HeuristicProvider()
    return [evaluate_one(label, active, hold_threshold) for label in labels]
