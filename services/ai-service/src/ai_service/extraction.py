"""Turn a provider completion into a contract-valid ExtractionResult."""

from __future__ import annotations

import json

from pydantic import ValidationError

from ai_service.documents import DocumentError, decode, document_text
from ai_service.providers import LLMProvider, ProviderError
from invoiceiq_contracts.ai_service import (
    DocumentExtractionRequest,
    ExtractedField,
    ExtractionRequest,
    ExtractionResult,
    Fields,
)

TASK = "extract_invoice_fields"
FIELD_NAMES = ("vendorName", "invoiceNumber", "invoiceDate", "currency", "totalMinor")


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
        documentSha256=request.documentSha256, provider=completion.provider, fields=fields
    )


def extract_document(request: DocumentExtractionRequest, provider: LLMProvider) -> ExtractionResult:
    """Extract from document bytes. No text layer means every field is unknown, not guessed."""
    data = decode(request.contentBase64, request.documentSha256)
    text = document_text(data, request.contentType.value)
    if not text.strip():
        empty = ExtractedField(value=None, confidence=0.0)
        return ExtractionResult(
            documentSha256=request.documentSha256,
            provider=f"{provider.name}:no-text-layer",
            fields=Fields(**dict.fromkeys(FIELD_NAMES, empty)),
        )
    as_text = ExtractionRequest(tenantId=request.tenantId, documentSha256=request.documentSha256, text=text)
    return extract(as_text, provider)


__all__ = ["DocumentError", "ExtractionError", "ProviderError", "extract", "extract_document"]
