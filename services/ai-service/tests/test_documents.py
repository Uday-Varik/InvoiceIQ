from __future__ import annotations

import base64
import hashlib
from pathlib import Path

import pytest

from ai_service.documents import DocumentError, decode, document_text, pdf_text
from ai_service.extraction import extract, extract_document
from ai_service.providers import HeuristicProvider
from invoiceiq_contracts.ai_service import DocumentExtractionRequest, ExtractionRequest

from .conftest import TENANT
from .pdf import SAMPLE_INVOICE_LINES, text_pdf

DOCS = Path(__file__).parent / "fixtures" / "documents"


def _request(data: bytes, content_type: str = "application/pdf") -> DocumentExtractionRequest:
    return DocumentExtractionRequest.model_validate(
        {
            "tenantId": TENANT,
            "documentSha256": hashlib.sha256(data).hexdigest(),
            "contentType": content_type,
            "contentBase64": base64.b64encode(data).decode(),
        }
    )


def test_committed_sample_pdfs_match_the_generator() -> None:
    assert (DOCS / "sample-invoice.pdf").read_bytes() == text_pdf(SAMPLE_INVOICE_LINES)


def test_pdf_text_reads_the_text_layer() -> None:
    text = pdf_text((DOCS / "sample-invoice.pdf").read_bytes())
    assert "Invoice Number: INV-2026-0042" in text
    assert "Total: 1,234.50" in text


def test_well_labelled_pdf_extracts_with_high_confidence() -> None:
    result = extract_document(_request((DOCS / "sample-invoice.pdf").read_bytes()), HeuristicProvider())
    f = result.fields
    assert (f.vendorName.value, f.invoiceNumber.value, f.invoiceDate.value) == (
        "ACME Industrial Supply",
        "INV-2026-0042",
        "2026-03-14",
    )
    assert (f.currency.value, f.totalMinor.value) == ("USD", "123450")
    header = ("vendorName", "invoiceNumber", "invoiceDate", "currency", "totalMinor")
    assert min(getattr(f, n).confidence for n in header) == 0.95
    # The sample prints no subtotal, tax or due date: unknown, not guessed.
    assert (f.subtotalMinor.value, f.taxMinor.value, f.dueDate.value) == (None, None, None)
    assert [(li.description, li.amountMinor) for li in result.lineItems] == [
        ("Hex bolts M8 x 200", "41200"),
        ("Safety gloves x 40", "82250"),
    ]


def test_messy_pdf_uses_loose_patterns_with_lower_confidence() -> None:
    result = extract_document(_request((DOCS / "messy-invoice.pdf").read_bytes()), HeuristicProvider())
    f = result.fields
    assert f.invoiceNumber.value == "NW-88812"
    assert f.invoiceDate.value == "2026-03-14"
    assert f.currency.value == "EUR"
    assert f.totalMinor.value == "240000", "balance due wins over subtotal and VAT"
    assert f.vendorName.value == "Northwind Traders Ltd"
    assert f.vendorName.confidence < 0.5, "a letterhead guess must not clear a hold threshold"


def test_image_without_ocr_returns_unknown_fields() -> None:
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    result = extract_document(_request(png, "image/png"), HeuristicProvider())
    assert result.provider == "heuristic:no-text-layer"
    assert all(getattr(result.fields, n).value is None for n in type(result.fields).model_fields)
    assert all(getattr(result.fields, n).confidence == 0.0 for n in type(result.fields).model_fields)


def test_sha_mismatch_is_refused() -> None:
    data = (DOCS / "sample-invoice.pdf").read_bytes()
    with pytest.raises(DocumentError, match="does not match"):
        decode(base64.b64encode(data).decode(), "0" * 64)


def test_bad_base64_is_refused() -> None:
    with pytest.raises(DocumentError, match="base64"):
        decode("not base64!!", "0" * 64)


def test_non_pdf_bytes_claiming_pdf_are_refused() -> None:
    with pytest.raises(DocumentError, match="not a PDF"):
        document_text(b"GIF89a....", "application/pdf")


def test_truncated_pdf_is_refused() -> None:
    data = (DOCS / "sample-invoice.pdf").read_bytes()[:120]
    with pytest.raises(DocumentError):
        pdf_text(data)


@pytest.mark.parametrize(
    ("text", "field", "expected", "confidence"),
    [
        ("Invoice No. A-17 issued today", "invoiceNumber", "A-17", 0.75),
        ("Invoice Date: March 4, 2026", "invoiceDate", "2026-03-04", 0.8),
        ("Date 25/03/2026", "invoiceDate", "2026-03-25", 0.7),
        ("Date 03/04/2026", "invoiceDate", "2026-03-04", 0.4),
        ("Amount due $99.00", "currency", "USD", 0.5),
        ("Grand total: GBP 1,000.00", "totalMinor", "100000", 0.75),
        ("Subtotal 10.00\nTotal due 12.00", "totalMinor", "1200", 0.75),
    ],
)
def test_loose_patterns(text: str, field: str, expected: str, confidence: float) -> None:
    req = ExtractionRequest.model_validate({"tenantId": TENANT, "documentSha256": "a" * 64, "text": text})
    got = getattr(extract(req, HeuristicProvider()).fields, field)
    assert (got.value, got.confidence) == (expected, confidence)


def test_labels_are_not_mistaken_for_invoice_numbers() -> None:
    req = ExtractionRequest.model_validate(
        {
            "tenantId": TENANT,
            "documentSha256": "a" * 64,
            "text": "Invoice Date 2026-01-01\nInvoice Total 5.00",
        }
    )
    assert extract(req, HeuristicProvider()).fields.invoiceNumber.value is None
