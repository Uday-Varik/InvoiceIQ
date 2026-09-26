"""OCR for scanned PDFs and PNG or JPEG images (Tesseract and Poppler command-line tools)."""

from __future__ import annotations

import base64
import hashlib
import os
import shutil
import struct
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ai_service import documents
from ai_service.api import create_app
from ai_service.api.observability import ServiceMetrics
from ai_service.documents import DocumentError, image_size, read_document
from ai_service.extraction import OCR_MAX_CONFIDENCE, extract_document
from ai_service.providers import HeuristicProvider
from invoiceiq_contracts.ai_service import DocumentExtractionRequest, ExtractionResult

from .conftest import TENANT

DOCS = Path(__file__).parent / "fixtures" / "documents"
SCANS = [
    ("scanned-invoice.png", "image/png"),
    ("scanned-invoice.jpg", "image/jpeg"),
    ("scanned-invoice.pdf", "application/pdf"),
]
HAVE_OCR = shutil.which("tesseract") is not None and shutil.which("pdftoppm") is not None

needs_ocr = pytest.mark.skipif(
    not HAVE_OCR and os.environ.get("REQUIRE_OCR") != "1",
    reason="tesseract and pdftoppm are not installed (CI sets REQUIRE_OCR=1)",
)


def _extract(name: str, content_type: str) -> ExtractionResult:
    data = (DOCS / name).read_bytes()
    req = DocumentExtractionRequest.model_validate(
        {
            "tenantId": TENANT,
            "documentSha256": hashlib.sha256(data).hexdigest(),
            "contentType": content_type,
            "contentBase64": base64.b64encode(data).decode(),
        }
    )
    return extract_document(req, HeuristicProvider())


def _fake_png(width: int, height: int) -> bytes:
    header = b"IHDR" + struct.pack(">II", width, height) + b"\x08\x02"
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + header


def test_ci_has_the_ocr_tools_when_it_says_so() -> None:
    if os.environ.get("REQUIRE_OCR") == "1":
        assert HAVE_OCR, "REQUIRE_OCR=1 but tesseract or pdftoppm is missing"


@needs_ocr
@pytest.mark.parametrize(("name", "content_type"), SCANS)
def test_scans_are_read_with_ocr(name: str, content_type: str) -> None:
    result = _extract(name, content_type)
    f = result.fields
    assert result.provider == "heuristic+ocr"
    assert (f.vendorName.value, f.invoiceNumber.value, f.invoiceDate.value, f.currency.value) == (
        "Kobe Precision Parts",
        "KP-7731",
        "2026-03-20",
        "JPY",
    )
    assert (f.subtotalMinor.value, f.taxMinor.value, f.totalMinor.value) == ("32000", "3200", "35200")
    lines = [(li.quantity, li.unitPriceMinor, li.amountMinor) for li in result.lineItems]
    assert lines == [("40", "800", "32000")]


@needs_ocr
@pytest.mark.parametrize(("name", "content_type"), SCANS)
def test_ocr_confidence_is_capped_but_clears_the_hold_threshold(name: str, content_type: str) -> None:
    result = _extract(name, content_type)
    confidences = [getattr(result.fields, n).confidence for n in type(result.fields).model_fields]
    confidences += [li.confidence for li in result.lineItems]
    assert max(confidences) <= OCR_MAX_CONFIDENCE
    assert result.fields.totalMinor.confidence == OCR_MAX_CONFIDENCE >= 0.8


def test_a_pdf_with_a_text_layer_skips_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("OCR must not run on a PDF with a text layer")

    monkeypatch.setattr(documents, "ocr_pdf", boom)
    doc = read_document((DOCS / "sample-invoice.pdf").read_bytes(), "application/pdf")
    assert doc.source == "text_layer"
    assert _extract("sample-invoice.pdf", "application/pdf").provider == "heuristic"


@pytest.mark.parametrize(("name", "content_type"), SCANS)
def test_without_ocr_tools_scans_yield_no_text(
    monkeypatch: pytest.MonkeyPatch, name: str, content_type: str
) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    result = _extract(name, content_type)
    assert result.provider == "heuristic:no-text-layer"
    assert all(getattr(result.fields, n).value is None for n in type(result.fields).model_fields)


@pytest.mark.parametrize(("name", "content_type"), SCANS[:2])
def test_image_size_is_read_from_the_header(name: str, content_type: str) -> None:
    assert image_size((DOCS / name).read_bytes(), content_type) == (1275, 620)


def test_a_huge_image_is_refused_before_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("tesseract must not see an oversized image")

    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(DocumentError, match="too large"):
        read_document(_fake_png(20_000, 20_000), "image/png")


@pytest.mark.parametrize(
    ("data", "content_type"),
    [
        (b"\x89PNG\r\n\x1a\n" + b"\x00" * 32, "image/png"),
        (b"GIF89a" + b"\x00" * 32, "image/png"),
        (b"\xff\xd8\xff\xe0" + b"\x00" * 8, "image/jpeg"),
        (b"\x89PNG\r\n\x1a\n", "image/jpeg"),
    ],
)
def test_malformed_images_are_refused(data: bytes, content_type: str) -> None:
    with pytest.raises(DocumentError):
        read_document(data, content_type)


def test_an_ocr_timeout_yields_no_text(monkeypatch: pytest.MonkeyPatch) -> None:
    def slow(*args: object, **_kwargs: object) -> None:
        raise subprocess.TimeoutExpired(cmd="tesseract", timeout=documents.OCR_TIMEOUT_SECONDS)

    monkeypatch.setattr(shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(subprocess, "run", slow)
    doc = read_document((DOCS / "scanned-invoice.png").read_bytes(), "image/png")
    assert (doc.text, doc.source) == ("", "none")


def test_ocr_runs_single_threaded_without_a_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def fake(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        seen.update(args=args, **kwargs)
        return subprocess.CompletedProcess(args, 0, stdout=b"Total: 1.00\n", stderr=b"")

    monkeypatch.setattr(shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(subprocess, "run", fake)
    doc = read_document((DOCS / "scanned-invoice.png").read_bytes(), "image/png")
    assert doc.source == "ocr"
    assert seen["args"] == ["/usr/bin/tesseract", "stdin", "stdout", "-l", "eng", "--psm", "6"]
    assert seen.get("shell") is None
    assert seen["timeout"] == documents.OCR_TIMEOUT_SECONDS
    env = seen["env"]
    assert isinstance(env, dict)
    assert env["OMP_THREAD_LIMIT"] == "1"
    assert set(env) == {"PATH", "OMP_THREAD_LIMIT", "LC_ALL"}, "no secrets reach the OCR subprocess"


def test_an_unsupported_type_is_refused() -> None:
    with pytest.raises(DocumentError, match="unsupported"):
        read_document(b"hello", "text/plain")


def _post(client: TestClient, name: str, content_type: str) -> int:
    data = (DOCS / name).read_bytes()
    body = {
        "tenantId": TENANT,
        "documentSha256": hashlib.sha256(data).hexdigest(),
        "contentType": content_type,
        "contentBase64": base64.b64encode(data).decode(),
    }
    return client.post("/v1/extract/document", json=body).status_code


@needs_ocr
def test_text_sources_are_counted() -> None:
    stats = ServiceMetrics()
    client = TestClient(create_app(HeuristicProvider(), metrics=stats))
    assert _post(client, "sample-invoice.pdf", "application/pdf") == 200
    assert _post(client, "scanned-invoice.png", "image/png") == 200
    assert _post(client, "scanned-invoice.pdf", "application/pdf") == 200
    assert stats.document_text.get({"source": "text_layer"}) == 1
    assert stats.document_text.get({"source": "ocr"}) == 2


def test_no_text_is_counted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    stats = ServiceMetrics()
    client = TestClient(create_app(HeuristicProvider(), metrics=stats))
    assert _post(client, "scanned-invoice.jpg", "image/jpeg") == 200
    assert stats.document_text.get({"source": "none"}) == 1
