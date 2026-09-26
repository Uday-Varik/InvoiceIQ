"""Turn a provider completion into a contract-valid ExtractionResult."""

from __future__ import annotations

import json

from pydantic import ValidationError

from ai_service.documents import DocumentError, decode, read_document
from ai_service.providers import LLMProvider, ProviderError
from invoiceiq_contracts.ai_service import (
    DocumentExtractionRequest,
    ExtractedField,
    ExtractedLineItem,
    ExtractionRequest,
    ExtractionResult,
    Fields,
)

TASK = "extract_invoice_fields"
FIELD_NAMES = (
    "vendorName",
    "invoiceNumber",
    "invoiceDate",
    "currency",
    "totalMinor",
    "subtotalMinor",
    "taxMinor",
    "dueDate",
)
MAX_LINE_ITEMS = 200


class ExtractionError(ValueError):
    """The provider output could not be turned into a valid extraction."""


def _field(raw: object) -> ExtractedField:
    if not isinstance(raw, dict):
        return ExtractedField(value=None, confidence=0.0)
    value = raw.get("value")
    confidence = raw.get("confidence", 0.0)
    try:
        return ExtractedField(value=None if value is None else str(value), confidence=float(confidence))
    except (TypeError, ValueError, ValidationError):
        return ExtractedField(value=None, confidence=0.0)


def _line_item(raw: object) -> ExtractedLineItem | None:
    """A provider line that breaks the contract is dropped, never repaired into something it did not say."""
    if not isinstance(raw, dict):
        return None

    def text(key: str) -> str | None:
        v = raw.get(key)
        return None if v is None else str(v)

    try:
        return ExtractedLineItem(
            description=str(raw.get("description", "")).strip()[:500],
            quantity=text("quantity"),
            unitPriceMinor=text("unitPriceMinor"),
            amountMinor=text("amountMinor"),
            confidence=float(raw.get("confidence", 0.0)),
        )
    except (TypeError, ValueError, ValidationError):
        return None


def _line_items(raw: object) -> list[ExtractedLineItem]:
    if not isinstance(raw, list):
        return []
    items = [_line_item(r) for r in raw[:MAX_LINE_ITEMS]]
    return [i for i in items if i is not None]


def extract(request: ExtractionRequest, provider: LLMProvider) -> ExtractionResult:
    completion = provider.complete(task=TASK, prompt=request.text)
    try:
        payload = json.loads(completion.text)
    except json.JSONDecodeError as exc:
        raise ExtractionError("provider returned non-JSON output") from exc
    if not isinstance(payload, dict):
        raise ExtractionError("provider returned a non-object")
    # Unknown keys from the model are dropped, missing ones get zero confidence:
    # a model can make an extraction less certain, never inject extra fields.
    fields = Fields(**{name: _field(payload.get(name)) for name in FIELD_NAMES})
    return ExtractionResult(
        documentSha256=request.documentSha256,
        provider=completion.provider,
        fields=fields,
        lineItems=_line_items(payload.get("lineItems")),
    )


# OCR misreads digits (5 and 6, 1 and 7), so a field read from a scan never scores
# higher than this; the arithmetic cross-check and the hold threshold still apply.
OCR_MAX_CONFIDENCE = 0.85


def extract_document(request: DocumentExtractionRequest, provider: LLMProvider) -> ExtractionResult:
    """Extract from document bytes. No readable text means every field is unknown, not guessed."""
    data = decode(request.contentBase64, request.documentSha256)
    doc = read_document(data, request.contentType.value)
    text = doc.text
    if not text.strip():
        empty = ExtractedField(value=None, confidence=0.0)
        return ExtractionResult(
            documentSha256=request.documentSha256,
            provider=f"{provider.name}:no-text-layer",
            fields=Fields(**dict.fromkeys(FIELD_NAMES, empty)),
            lineItems=[],
        )
    as_text = ExtractionRequest(tenantId=request.tenantId, documentSha256=request.documentSha256, text=text)
    result = extract(as_text, provider)
    if doc.source != "ocr":
        return result
    capped = {
        name: field.model_copy(update={"confidence": min(field.confidence, OCR_MAX_CONFIDENCE)})
        for name, field in result.fields
    }
    return result.model_copy(
        update={
            "provider": f"{result.provider}+ocr",
            "fields": Fields(**capped),
            "lineItems": [
                li.model_copy(update={"confidence": min(li.confidence, OCR_MAX_CONFIDENCE)})
                for li in result.lineItems
            ],
        }
    )


__all__ = ["DocumentError", "ExtractionError", "ProviderError", "extract", "extract_document"]
