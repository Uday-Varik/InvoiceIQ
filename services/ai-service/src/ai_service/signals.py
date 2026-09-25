"""Advisory risk signals.

The only constructor for a Signal is `hold_signal`, which takes an AiReasonCode
and hard-codes outcome="HOLD". The contract model itself types `outcome` as
Literal["HOLD"], so even a bypass would fail validation. See ADR-0007.
"""

from __future__ import annotations

from invoiceiq_contracts.ai_service import AiReasonCode, Signal, SignalRequest, SignalResponse

# Fields that decide who gets paid and how much. Low confidence on any of them holds.
MONEY_BEARING_FIELDS = ("vendorName", "invoiceNumber", "currency", "totalMinor")


def hold_signal(code: AiReasonCode, score: float, evidence: str) -> Signal:
    return Signal(
        reasonCode=code, outcome="HOLD", score=round(min(max(score, 0.0), 1.0), 4), evidence=evidence[:2000]
    )


def compute_signals(request: SignalRequest) -> SignalResponse:
    fields = request.extraction.fields
    threshold = request.extractionConfidenceHoldBelow
    low = [
        (name, getattr(fields, name).confidence)
        for name in MONEY_BEARING_FIELDS
        if getattr(fields, name).confidence < threshold or getattr(fields, name).value is None
    ]
    signals: list[Signal] = []
    if low:
        worst = min(conf for _, conf in low)
        evidence = ", ".join(f"{name}={conf:.2f}" for name, conf in low) + f" (threshold {threshold:.2f})"
        signals.append(hold_signal(AiReasonCode.AI_EXTRACTION_LOW_CONFIDENCE, 1.0 - worst, evidence))
    return SignalResponse(signals=signals)
