"""Turn an uploaded document into text for extraction.

A PDF's text layer is used when it has one. Scanned PDFs and PNG or JPEG
images go through OCR: the Tesseract and Poppler command-line tools, run as
subprocesses with a timeout, one thread, and a pixel cap checked from the image
header before anything decodes it. Without those tools installed, such
documents yield no text and every field comes back unknown (a human reads them).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import logging
import os
import shutil
import struct
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pypdf import PdfReader
from pypdf.errors import PyPdfError

MAX_PAGES = 20
MAX_TEXT_CHARS = 200_000
PDF_MAGIC = b"%PDF-"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"

# OCR limits. A 40-megapixel cap stops decompression bombs before Tesseract decodes anything;
# scanned PDFs are rasterised at 200 dpi, first pages only.
MAX_OCR_PIXELS = 40_000_000
MAX_OCR_PAGES = 3
OCR_DPI = 200
OCR_TIMEOUT_SECONDS = 30.0
# A text layer shorter than this (after trimming) is a scan with a stray watermark, not text.
MIN_TEXT_LAYER_CHARS = 16

TextSource = Literal["text_layer", "ocr", "none"]

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


@dataclass(frozen=True)
class DocumentText:
    text: str
    source: TextSource


def ocr_available() -> bool:
    """True when the tesseract binary is on PATH (pdftoppm is also needed for scanned PDFs)."""
    return shutil.which("tesseract") is not None


def image_size(data: bytes, content_type: str) -> tuple[int, int]:
    """(width, height) from the PNG or JPEG header, without decoding pixels."""
    if content_type == "image/png":
        if not data.startswith(PNG_MAGIC) or data[12:16] != b"IHDR" or len(data) < 24:
            raise DocumentError("document is not a PNG image")
        width, height = struct.unpack(">II", data[16:24])
        return width, height
    if content_type == "image/jpeg":
        if not data.startswith(JPEG_MAGIC):
            raise DocumentError("document is not a JPEG image")
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                raise DocumentError("unreadable JPEG header")
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            (length,) = struct.unpack(">H", data[i + 2 : i + 4])
            # SOF0..SOF15 carry the frame size; C4, C8 and CC are tables, not frames.
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", data[i + 5 : i + 9])
                return width, height
            i += 2 + length
        raise DocumentError("unreadable JPEG header")
    raise DocumentError(f"not an image: {content_type}")


def _run(args: list[str], stdin: bytes | None = None) -> bytes | None:
    """Run an OCR tool; None when it fails or times out (the document is then treated as unreadable text)."""
    env = {"PATH": os.environ.get("PATH", ""), "OMP_THREAD_LIMIT": "1", "LC_ALL": "C"}
    try:
        done = subprocess.run(  # noqa: S603 - fixed binaries, no shell, arguments built here
            args, input=stdin, capture_output=True, timeout=OCR_TIMEOUT_SECONDS, env=env, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("OCR tool %s failed: %s", args[0], type(exc).__name__)
        return None
    if done.returncode != 0:
        log.warning("OCR tool %s exited with %d", args[0], done.returncode)
        return None
    return done.stdout


def _tesseract(image: bytes) -> str:
    tesseract = shutil.which("tesseract")
    if tesseract is None:
        return ""
    # --psm 6 reads the page as one block of text, which keeps invoice rows on one line each.
    out = _run([tesseract, "stdin", "stdout", "-l", "eng", "--psm", "6"], stdin=image)
    return out.decode("utf-8", errors="replace") if out else ""


def ocr_image(data: bytes, content_type: str) -> str:
    """OCR text of a PNG or JPEG, or "" when OCR is unavailable or fails."""
    width, height = image_size(data, content_type)
    if width * height > MAX_OCR_PIXELS:
        raise DocumentError(f"image is too large to read ({width}x{height} pixels)")
    return _tesseract(data)[:MAX_TEXT_CHARS]


def ocr_pdf(data: bytes) -> str:
    """OCR text of the first MAX_OCR_PAGES pages of a scanned PDF, or "" when OCR is unavailable."""
    pdftoppm = shutil.which("pdftoppm")
    if pdftoppm is None or not ocr_available():
        return ""
    with tempfile.TemporaryDirectory(prefix="invoiceiq-ocr-") as tmp:
        source = Path(tmp) / "in.pdf"
        source.write_bytes(data)
        # -scale-to caps the longest side, so a huge page size cannot become a huge bitmap.
        side = str(int(MAX_OCR_PIXELS**0.5))
        args = [pdftoppm, "-r", str(OCR_DPI), "-scale-to", side, "-f", "1", "-l", str(MAX_OCR_PAGES)]
        if _run([*args, "-png", str(source), str(Path(tmp) / "page")]) is None:
            return ""
        pages = sorted(Path(tmp).glob("page*.png"))
        return "\n".join(_tesseract(page.read_bytes()) for page in pages)[:MAX_TEXT_CHARS]


def read_document(data: bytes, content_type: str) -> DocumentText:
    """Text for extraction and where it came from: the PDF text layer, OCR, or nothing."""
    if content_type == "application/pdf":
        text = pdf_text(data)
        if len(text.strip()) >= MIN_TEXT_LAYER_CHARS:
            return DocumentText(text, "text_layer")
        scanned = ocr_pdf(data)
        return DocumentText(scanned, "ocr") if scanned.strip() else DocumentText(text, "none")
    if content_type in ("image/png", "image/jpeg"):
        text = ocr_image(data, content_type)
        if not text.strip() and not ocr_available():
            log.info("OCR is not installed; %s yields no text", content_type)
        return DocumentText(text, "ocr") if text.strip() else DocumentText("", "none")
    raise DocumentError(f"unsupported content type: {content_type}")


def document_text(data: bytes, content_type: str) -> str:
    """Text for extraction ("" when the document has none that can be read)."""
    return read_document(data, content_type).text
