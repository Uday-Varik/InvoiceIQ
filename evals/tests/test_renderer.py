from invoiceiq_data.labels import LabelRecord
from invoiceiq_evals.renderer import render


def test_render_usd() -> None:
    label = LabelRecord(
        doc_id="DOC-aabbccddeeff",
        family_id="FAM-aabbccdd",
        vendor_id="VEN-0001",
        invoice_number="INV-2026-00001",
        invoice_date="2026-01-15",
        currency="USD",
        total_minor=123456,
        is_attack=False,
        expected_outcome="PASS",
    )
    text = render(label)
    assert "Vendor: VEN-0001" in text
    assert "Invoice No: INV-2026-00001" in text
    assert "Date: 2026-01-15" in text
    assert "Currency: USD" in text
    assert "Total: 1234.56" in text


def test_render_jpy() -> None:
    label = LabelRecord(
        doc_id="DOC-aabbccddeeff",
        family_id="FAM-aabbccdd",
        vendor_id="VEN-0002",
        invoice_number="INV-2026-00002",
        invoice_date="2026-03-10",
        currency="JPY",
        total_minor=35200,
        is_attack=False,
        expected_outcome="PASS",
    )
    text = render(label)
    assert "Total: 35200" in text
    assert "Currency: JPY" in text


def test_render_bhd() -> None:
    label = LabelRecord(
        doc_id="DOC-aabbccddeeff",
        family_id="FAM-aabbccdd",
        vendor_id="VEN-0003",
        invoice_number="INV-2026-00003",
        invoice_date="2026-06-01",
        currency="BHD",
        total_minor=1500,
        is_attack=False,
        expected_outcome="PASS",
    )
    text = render(label)
    assert "Total: 1.500" in text
    assert "Currency: BHD" in text
