"""Build tiny single-page PDFs with a real text layer, for tests and sample fixtures."""

from __future__ import annotations


def _escape(line: str) -> str:
    return line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_pdf(lines: list[str]) -> bytes:
    """A valid PDF 1.4 file that prints `lines` in Helvetica, one per row."""
    rows = ["BT", "/F1 11 Tf", "14 TL", "56 780 Td"]
    for line in lines:
        rows.append(f"({_escape(line)}) Tj T*")
    rows.append("ET")
    stream = "\n".join(rows).encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


SAMPLE_INVOICE_LINES = [
    "ACME Industrial Supply",
    "1200 Harbor Way, Oakland CA",
    "",
    "Vendor: ACME Industrial Supply",
    "Invoice Number: INV-2026-0042",
    "Date: 2026-03-14",
    "Currency: USD",
    "",
    "Hex bolts M8 x 200        412.00",
    "Safety gloves x 40        822.50",
    "",
    "Total: 1,234.50",
]

MESSY_INVOICE_LINES = [
    "Northwind Traders Ltd",
    "TAX INVOICE",
    "Invoice # NW-88812      Invoice Date 14 Mar 2026",
    "Consulting services (March)     EUR 2,000.00",
    "Subtotal                        EUR 2,000.00",
    "VAT 20%                         EUR 400.00",
    "Balance due                     EUR 2,400.00",
]

SCANNED_INVOICE_LINES = [
    "Kobe Precision Parts",
    "Vendor: Kobe Precision Parts",
    "Invoice Number: KP-7731",
    "Date: 2026-03-20",
    "Currency: JPY",
    "",
    "Bearings 6204    40    800    32,000",
    "",
    "Subtotal: 32,000",
    "Tax: 3,200",
    "Total: 35,200",
]


def image_pdf(jpeg: bytes, width: int, height: int) -> bytes:
    """A PDF whose only page is a JPEG and which has no text layer: what a scanner produces."""
    content = f"q 612 0 0 {612 * height // width} 0 {842 - 612 * height // width} cm /Im1 Do Q".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] "
        b"/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
        f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB "
        f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg)} >>\nstream\n".encode()
        + jpeg
        + b"\nendstream",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
