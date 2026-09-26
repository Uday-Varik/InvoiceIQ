"""Amounts are read in each currency's own decimal places (yen 0, dinars 3, dollars 2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_service.currency import DEFAULT_EXPONENT, EXPONENTS, exponent
from ai_service.extraction import extract
from ai_service.providers import HeuristicProvider
from invoiceiq_contracts.ai_service import ExtractionRequest, ExtractionResult

from .conftest import SHA, TENANT

CATALOG = Path(__file__).resolve().parents[3] / "packages/contracts/catalog/reason-codes.json"


def _run(text: str) -> ExtractionResult:
    req = ExtractionRequest.model_validate({"tenantId": TENANT, "documentSha256": SHA, "text": text})
    return extract(req, HeuristicProvider())


def _value(result: ExtractionResult, field: str) -> str | None:
    value: str | None = getattr(result.fields, field).value
    return value


def test_table_matches_the_core_api_catalog() -> None:
    table = dict(json.loads(CATALOG.read_text())["currencyExponents"])
    assert table.pop("default") == DEFAULT_EXPONENT
    assert table == EXPONENTS


@pytest.mark.parametrize(
    ("code", "e"), [("JPY", 0), ("KRW", 0), ("BHD", 3), ("KWD", 3), ("USD", 2), (None, 2)]
)
def test_exponent(code: str | None, e: int) -> None:
    assert exponent(code) == e


def test_labelled_yen_invoice() -> None:
    r = _run("Currency: JPY\nSubtotal: 100,000\nTax: 10,000\nTotal: 110,000\n")
    assert _value(r, "currency") == "JPY"
    amounts = (_value(r, "subtotalMinor"), _value(r, "taxMinor"), _value(r, "totalMinor"))
    assert amounts == ("100000", "10000", "110000")
    assert r.fields.totalMinor.confidence >= 0.9


def test_yen_symbol_and_line_items() -> None:
    text = "\n".join(
        [
            "Tanaka Shoji K.K.",
            "Invoice No: T-2026-9",
            "Invoice Date: 2026-03-14",
            "Tel 03 1234 5678",
            "Bolts M8 100 ¥1,000 ¥100,000",
            "Delivery ¥5,000",
            "Subtotal ¥105,000",
            "Consumption tax 10% ¥10,500",
            "Total ¥115,500",
        ]
    )
    r = _run(text)
    assert _value(r, "currency") == "JPY"
    assert _value(r, "totalMinor") == "115500"
    assert _value(r, "subtotalMinor") == "105000"
    assert _value(r, "taxMinor") == "10500"
    lines = [(li.description, li.quantity, li.unitPriceMinor, li.amountMinor) for li in r.lineItems]
    # The phone number is not a line; the two priced lines are.
    assert lines == [("Bolts M8", "100", "1000", "100000"), ("Delivery", None, None, "5000")]
    assert r.fields.totalMinor.confidence >= 0.9


def test_yen_decimals_are_not_read_as_yen() -> None:
    # "12.50" is not a yen amount; nothing is invented from it.
    r = _run("Currency: JPY\nTotal: 12.50\n")
    assert _value(r, "totalMinor") is None


def test_dinar_invoice_with_three_decimals() -> None:
    text = "Currency: BHD\nWidgets 2 12.500 25.000\nSubtotal: 25.000\nVAT: 2.500\nTotal: 27.500\n"
    r = _run(text)
    amounts = (_value(r, "subtotalMinor"), _value(r, "taxMinor"), _value(r, "totalMinor"))
    assert amounts == ("25000", "2500", "27500")
    lines = [(li.unitPriceMinor, li.amountMinor, li.confidence) for li in r.lineItems]
    assert lines == [("12500", "25000", 0.85)]


def test_dinar_amount_with_two_decimals_is_not_misread() -> None:
    r = _run("Currency: KWD\nTotal: 27.50\n")
    assert _value(r, "totalMinor") is None


def test_dollars_unchanged() -> None:
    r = _run("Currency: USD\nSubtotal: 1,000.00\nTax: 234.50\nTotal: 1,234.50\n")
    assert _value(r, "totalMinor") == "123450"
    assert r.fields.totalMinor.confidence >= 0.9


def test_won_symbol() -> None:
    r = _run("Invoice total ₩1,250,000")
    assert (_value(r, "currency"), _value(r, "totalMinor")) == ("KRW", "1250000")
