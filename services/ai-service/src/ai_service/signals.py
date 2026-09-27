"""Advisory risk signals.

The only constructor for a Signal is `hold_signal`, which takes an AiReasonCode
and hard-codes outcome="HOLD". The contract model itself types `outcome` as
Literal["HOLD"], so even a bypass would fail validation. See ADR-0007.
"""

from __future__ import annotations

from invoiceiq_contracts.ai_service import AiReasonCode, Flag, Signal, SignalRequest, SignalResponse

# Fields that decide who gets paid and how much. Low confidence on any of them holds.
MONEY_BEARING_FIELDS = ("vendorName", "invoiceNumber", "currency", "totalMinor")

_FLAG_TO_CODE: dict[Flag, AiReasonCode] = {
    Flag.anomaly_suspected: AiReasonCode.AI_ANOMALY_SUSPECTED,
    Flag.document_tampering: AiReasonCode.AI_DOCUMENT_TAMPERING_SUSPECTED,
    Flag.semantic_duplicate: AiReasonCode.AI_SEMANTIC_DUPLICATE_SUSPECTED,
}
RISK_FLAG_HOLD_ABOVE = 0.5


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

    for rf in request.extraction.riskFlags or []:
        if rf.score < RISK_FLAG_HOLD_ABOVE:
            continue
        code = _FLAG_TO_CODE.get(rf.flag)
        if code is None:
            continue
        signals.append(hold_signal(code, rf.score, rf.evidence))

    return SignalResponse(signals=signals)
