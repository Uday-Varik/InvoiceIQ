"""Phase 2 extraction: subtotal, tax, due date, line items and the arithmetic cross-check."""

from __future__ import annotations

import base64
import hashlib
import json

import pytest

from ai_service.extraction import MAX_LINE_ITEMS, DocumentError, extract, extract_document
from ai_service.providers import Completion, HeuristicProvider
from invoiceiq_contracts.ai_service import DocumentExtractionRequest, ExtractionRequest, ExtractionResult

from .conftest import SHA, TENANT
from .pdf import MESSY_INVOICE_LINES, SAMPLE_INVOICE_LINES, text_pdf


def _run(text: str) -> ExtractionResult:
    req = ExtractionRequest.model_validate({"tenantId": TENANT, "documentSha256": SHA, "text": text})
    return extract(req, HeuristicProvider())


def _pdf(lines: list[str]) -> ExtractionResult:
    data = text_pdf(lines)
    req = DocumentExtractionRequest.model_validate(
        {
            "tenantId": TENANT,
            "documentSha256": hashlib.sha256(data).hexdigest(),
            "contentType": "application/pdf",
            "contentBase64": base64.b64encode(data).decode(),
        }
    )
    return extract_document(req, HeuristicProvider())


class _Static:
    name = "static"

    def __init__(self, payload: object) -> None:
        self.text = json.dumps(payload)

    def complete(self, *, task: str, prompt: str) -> Completion:
        return Completion(provider=self.name, model="m", text=self.text)


def _static(payload: object) -> ExtractionResult:
    req = ExtractionRequest.model_validate({"tenantId": TENANT, "documentSha256": SHA, "text": "x"})
    return extract(req, _Static(payload))


# ---- subtotal ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected", "confidence"),
    [
        ("Subtotal: 1,000.00", "100000", 0.95),
        ("Sub-total: 10.00", "1000", 0.95),
        ("SUBTOTAL # 0.50", "50", 0.95),
        ("Subtotal           EUR 2,000.00", "200000", 0.8),
        ("Sub total $12.34", "1234", 0.8),
        ("Subtotal (USD) 99.99", "9999", 0.8),
        ("Subtotal ₹ 1,50,000.00", None, 0.0),
    ],
)
def test_subtotal(text: str, expected: str | None, confidence: float) -> None:
    f = _run(text).fields.subtotalMinor
    assert (f.value, f.confidence) == (expected, confidence)


def test_subtotal_is_never_read_as_the_total() -> None:
    f = _run("Subtotal 10.00").fields
    assert f.subtotalMinor.value == "1000"
    assert f.totalMinor.value is None


# ---- tax --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected", "confidence"),
    [
        ("Tax: 12.00", "1200", 0.95),
        ("VAT: 400.00", "40000", 0.95),
        ("GST: 18.00", "1800", 0.95),
        ("Sales tax: 7.25", "725", 0.95),
        ("VAT 20%        EUR 400.00", "40000", 0.8),
        ("GST @ 18% ₹ 180.00", "18000", 0.8),
        ("Sales Tax (8.875%)  $88.75", "8875", 0.8),
        ("HST 13% 130.00", "13000", 0.8),
        ("CGST 9% 90.00\nSGST 9% 90.00", "18000", 0.7),
        ("GST 5% 5.00\nPST 7% 7.00", "1200", 0.7),
        ("Output VAT 21.00", "2100", 0.8),
    ],
)
def test_tax(text: str, expected: str, confidence: float) -> None:
    f = _run(text).fields.taxMinor
    assert (f.value, f.confidence) == (expected, confidence)


@pytest.mark.parametrize(
    "text",
    [
        "TAX INVOICE",
        "Total incl. tax 120.00",
        "Total including VAT 120.00",
        "Tax ID: 12-3456789",
        "VAT number GB123456789",
        "Price excl. VAT 100.00",
    ],
)
def test_things_that_mention_tax_but_are_not_tax(text: str) -> None:
    assert _run(text).fields.taxMinor.value is None


# ---- due date ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected", "confidence"),
    [
        ("Due Date: 2026-04-13", "2026-04-13", 0.95),
        ("Due date 2026-04-13", "2026-04-13", 0.85),
        ("Payment due 13 Apr 2026", "2026-04-13", 0.8),
        ("Due by April 13, 2026", "2026-04-13", 0.8),
        ("Pay by 13/04/2026", "2026-04-13", 0.7),
        ("Due on 04/05/2026", "2026-04-05", 0.4),
    ],
)
def test_due_date(text: str, expected: str, confidence: float) -> None:
    f = _run(text).fields.dueDate
    assert (f.value, f.confidence) == (expected, confidence)


@pytest.mark.parametrize(
    "text",
    [
        "Due Date: 2026-04-13",
        "Due date 2026-04-13",
        "Payment Due Date 13 Apr 2026",
    ],
)
def test_a_due_date_is_not_read_as_the_invoice_date(text: str) -> None:
    assert _run(text).fields.invoiceDate.value is None


def test_invoice_date_and_due_date_side_by_side() -> None:
    f = _run("Invoice Date: 2026-03-14\nDue Date: 2026-04-13").fields
    assert (f.invoiceDate.value, f.dueDate.value) == ("2026-03-14", "2026-04-13")


@pytest.mark.parametrize(
    ("text", "expected", "confidence"),
    [
        ("Date: 2026-03-14\nTerms: Net 30", "2026-04-13", 0.65),
        ("Date: 2026-12-15\nNet 30 days", "2027-01-14", 0.65),
        ("Date: 2026-02-01\nPayment terms NET15", "2026-02-16", 0.65),
        ("Invoice Date 03/04/2026\nNet 30", "2026-04-03", 0.4),
    ],
)
def test_net_terms_count_from_the_invoice_date(text: str, expected: str, confidence: float) -> None:
    f = _run(text).fields.dueDate
    assert (f.value, f.confidence) == (expected, confidence)


def test_net_terms_without_an_invoice_date_are_unknown() -> None:
    assert _run("Terms: Net 30").fields.dueDate.value is None


def test_absurd_net_terms_are_ignored() -> None:
    assert _run("Date: 2026-03-14\nNet 900").fields.dueDate.value is None


def test_an_explicit_due_date_beats_net_terms() -> None:
    f = _run("Date: 2026-03-14\nNet 30\nDue Date: 2026-05-01").fields.dueDate
    assert (f.value, f.confidence) == ("2026-05-01", 0.95)


# ---- line items -------------------------------------------------------------


def test_quantity_unit_amount_lines() -> None:
    items = _run("Widget 2 10.00 20.00\nGadget 3 5.50 16.50\nTotal: 36.50").lineItems
    assert [(i.description, i.quantity, i.unitPriceMinor, i.amountMinor) for i in items] == [
        ("Widget", "2", "1000", "2000"),
        ("Gadget", "3", "550", "1650"),
    ]
    assert all(i.confidence == 0.85 for i in items)


def test_line_whose_columns_do_not_multiply_scores_low() -> None:
    [item] = _run("Gadget 3 5.50 16.00").lineItems
    assert item.confidence == 0.5


@pytest.mark.parametrize(
    ("line", "quantity", "unit", "amount"),
    [
        ("Consulting hours 12.5 80.00 1,000.00", "12.5", "8000", "100000"),
        ("Bolts 1,000 pack 4 25.00 100.00", "4", "2500", "10000"),
        ("Paper A4 10 x 4.99 49.90", "10", "499", "4990"),
        ("Cable 2 @ $3.00 $6.00", "2", "300", "600"),
        ("Licence 1 EUR 1,200.00 EUR 1,200.00", "1", "120000", "120000"),
        ("Credit for returned item 1 -10.00 -10.00", "1", "-1000", "-1000"),
    ],
)
def test_line_item_shapes(line: str, quantity: str, unit: str, amount: str) -> None:
    [item] = _run(line).lineItems
    assert (item.quantity, item.unitPriceMinor, item.amountMinor) == (quantity, unit, amount)


def test_amount_only_lines() -> None:
    items = _run("Design work        1,500.00\nHosting (March)   EUR 20.00").lineItems
    assert [(i.description, i.quantity, i.amountMinor, i.confidence) for i in items] == [
        ("Design work", None, "150000", 0.6),
        ("Hosting (March)", None, "2000", 0.6),
    ]


def test_lines_stop_at_the_first_summary_line() -> None:
    text = "Widget 1 10.00 10.00\nSubtotal 10.00\nShipping 5.00\nTotal 15.00"
    assert [i.description for i in _run(text).lineItems] == ["Widget"]


@pytest.mark.parametrize(
    "line",
    [
        "Invoice Number: INV-1 100.00",
        "Date 2026-03-14 12.00",
        "Balance due 50.00",
        "Payment received -50.00",
        "Discount -5.00",
        "Page 1 of 2",
        "Bill to: Acme 10.00",
        "IBAN GB00 0000 12.00",
    ],
)
def test_non_lines_are_skipped(line: str) -> None:
    assert _run(line).lineItems == []


def test_header_rows_without_amounts_are_not_lines() -> None:
    assert _run("Description   Qty   Unit price   Amount").lineItems == []


def test_description_is_trimmed_of_trailing_separators() -> None:
    [item] = _run("Support plan ....... 99.00").lineItems
    assert item.description == "Support plan"


def test_line_items_are_capped() -> None:
    text = "\n".join(f"Item {n} 1 1.00 1.00" for n in range(MAX_LINE_ITEMS + 50))
    assert len(_run(text).lineItems) == MAX_LINE_ITEMS


def test_no_lines_is_an_empty_list() -> None:
    assert _run("nothing useful here").lineItems == []


# ---- cross-check ------------------------------------------------------------


def test_subtotal_plus_tax_equal_to_total_corroborates_a_loose_total() -> None:
    f = _run("Subtotal 100.00\nVAT 20% 20.00\nBalance due 120.00").fields
    assert (f.totalMinor.value, f.totalMinor.confidence) == ("12000", 0.9)


def test_subtotal_plus_tax_that_does_not_add_up_doubts_the_total() -> None:
    f = _run("Subtotal: 100.00\nTax: 20.00\nTotal: 130.00").fields
    assert f.totalMinor.value == "13000"
    assert f.totalMinor.confidence == 0.5


def test_line_sum_plus_tax_corroborates_the_total() -> None:
    f = _run("Widget 2 10.00 20.00\nTax 10% 2.00\nInvoice total 22.00").fields
    assert f.totalMinor.confidence == 0.9


def test_line_sum_that_misses_does_not_doubt_the_total() -> None:
    # A line the parser missed is not evidence the total is wrong.
    f = _run("Widget 2 10.00 20.00\nGrand total 99.00").fields
    assert f.totalMinor.confidence == 0.75


def test_subtotal_alone_that_differs_leaves_the_total_alone() -> None:
    f = _run("Subtotal 100.00\nShipping 5.00\nTotal due 105.00").fields
    assert f.totalMinor.confidence == 0.75


def test_strict_total_is_never_lowered_by_agreeing_arithmetic() -> None:
    f = _run("Subtotal: 100.00\nTax: 20.00\nTotal: 120.00").fields
    assert f.totalMinor.confidence == 0.95


# ---- whole documents --------------------------------------------------------


def test_messy_pdf_reads_subtotal_vat_and_its_line() -> None:
    result = _pdf(MESSY_INVOICE_LINES)
    f = result.fields
    assert (f.subtotalMinor.value, f.taxMinor.value, f.totalMinor.value) == ("200000", "40000", "240000")
    assert f.totalMinor.confidence == 0.9
    assert [(i.description, i.amountMinor) for i in result.lineItems] == [
        ("Consulting services (March)", "200000")
    ]


def test_indian_gst_invoice() -> None:
    result = _pdf(
        [
            "Sharma Traders Pvt Ltd",
            "GSTIN 27AAACS1234A1Z5",
            "Invoice No: ST/2026/118",
            "Invoice Date: 14 Mar 2026",
            "Payment terms: Net 15",
            "Steel rods 10 450.00 4,500.00",
            "Transport 1 500.00 500.00",
            "Subtotal 5,000.00",
            "CGST 9% 450.00",
            "SGST 9% 450.00",
            "Total INR 5,900.00",
        ]
    )
    f = result.fields
    assert f.invoiceNumber.value == "ST/2026/118"
    assert f.currency.value == "INR"
    assert (f.subtotalMinor.value, f.taxMinor.value, f.totalMinor.value) == ("500000", "90000", "590000")
    assert f.dueDate.value == "2026-03-29"
    assert f.totalMinor.confidence == 0.9
    assert [(i.description, i.quantity, i.amountMinor) for i in result.lineItems] == [
        ("Steel rods", "10", "450000"),
        ("Transport", "1", "50000"),
    ]


def test_sample_pdf_lines_sum_to_the_total() -> None:
    result = _pdf(SAMPLE_INVOICE_LINES)
    assert sum(int(i.amountMinor or 0) for i in result.lineItems) == int(result.fields.totalMinor.value or 0)


def test_corrupt_image_is_unreadable_not_guessed() -> None:
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    req = DocumentExtractionRequest.model_validate(
        {
            "tenantId": TENANT,
            "documentSha256": hashlib.sha256(data).hexdigest(),
            "contentType": "image/png",
            "contentBase64": base64.b64encode(data).decode(),
        }
    )
    # core-api holds an unreadable document for manual review.
    with pytest.raises(DocumentError, match="not a PNG"):
        extract_document(req, HeuristicProvider())


# ---- provider output hygiene ------------------------------------------------


def test_provider_lines_that_break_the_contract_are_dropped() -> None:
    result = _static(
        {
            "lineItems": [
                {
                    "description": "ok",
                    "quantity": "2",
                    "unitPriceMinor": "5",
                    "amountMinor": "10",
                    "confidence": 0.9,
                },
                {"description": "", "amountMinor": "10", "confidence": 0.9},
                {"description": "float qty", "quantity": "1e3", "amountMinor": "10", "confidence": 0.9},
                {"description": "bad amount", "amountMinor": "12.50", "confidence": 0.9},
                {"description": "bad confidence", "amountMinor": "1", "confidence": 3},
                "not an object",
            ]
        }
    )
    assert [i.description for i in result.lineItems] == ["ok"]


def test_numeric_provider_values_are_carried_as_strings() -> None:
    [item] = _static(
        {"lineItems": [{"description": "x", "quantity": 2, "unitPriceMinor": 5, "amountMinor": 10}]}
    ).lineItems
    assert (item.quantity, item.unitPriceMinor, item.amountMinor, item.confidence) == ("2", "5", "10", 0.0)


def test_non_list_line_items_become_empty() -> None:
    assert _static({"lineItems": {"description": "x"}}).lineItems == []


def test_provider_that_omits_the_new_fields_gets_zero_confidence() -> None:
    f = _static({"totalMinor": {"value": "1", "confidence": 0.9}}).fields
    for name in ("subtotalMinor", "taxMinor", "dueDate"):
        assert (getattr(f, name).value, getattr(f, name).confidence) == (None, 0.0)


def test_provider_line_items_are_capped() -> None:
    lines = [{"description": f"l{n}", "amountMinor": "1", "confidence": 0.5} for n in range(500)]
    assert len(_static({"lineItems": lines}).lineItems) == MAX_LINE_ITEMS
