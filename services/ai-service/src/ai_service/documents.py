"""Turn an uploaded document into text for extraction (baseline: PDF text layer only)."""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import logging

from pypdf import PdfReader
from pypdf.errors import PyPdfError

MAX_PAGES = 20
MAX_TEXT_CHARS = 200_000
PDF_MAGIC = b"%PDF-"

log = logging.getLogger(__name__)


class DocumentError(ValueError):
    """The document is not what it claims to be or cannot be read."""


def decode(content_base64: str, expected_sha256: str) -> bytes:
    try:
        data = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DocumentError("contentBase64 is not valid base64") from exc
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise DocumentError("documentSha256 does not match the document bytes")
    return data


def pdf_text(data: bytes) -> str:
    """Text of the first MAX_PAGES pages. Empty for scanned PDFs with no text layer."""
    if not data.startswith(PDF_MAGIC):
        raise DocumentError("document is not a PDF")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise DocumentError("encrypted PDFs are not supported")
        parts: list[str] = []
        for page in reader.pages[:MAX_PAGES]:
            parts.append(page.extract_text() or "")
    except PyPdfError as exc:
        raise DocumentError(f"unreadable PDF: {exc}") from exc
    return "\n".join(parts)[:MAX_TEXT_CHARS]


def document_text(data: bytes, content_type: str) -> str:
    """Text for extraction. Images return "" because the baseline has no OCR."""
    if content_type == "application/pdf":
        return pdf_text(data)
    log.info("no text layer for %s in the baseline extractor", content_type)
    return ""
