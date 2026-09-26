"""Deterministic, offline provider used in development and as the replay baseline.

It pulls fields with regular expressions and reports honest confidences. A
labelled `Field: value` line scores 0.95. When no such line exists, looser
patterns written for real PDF text layers ("Invoice # INV-1 Date 14 Mar 2026",
"Balance due $1,200.00") are tried and score lower, because each one involves a
guess (which number is the total, which currency "$" means). A missing field
scores 0.0. A real model provider plugs in behind the same interface later.

Amounts are read in the currency's own decimal places (ISO 4217): "12,000" for
yen, "1.250" for Bahraini dinars, "12.00" for dollars. The currency is found
first and the amount patterns are built for its exponent; an unknown currency
is read with 2 decimals.

Beyond the header it reads the subtotal, tax (summing split taxes such as
CGST + SGST), the due date (a labelled date, or "Net 30" terms counted from the
invoice date) and the body lines. The arithmetic is then cross-checked: when
subtotal (or the sum of the lines) plus tax equals the total, the total is
corroborated and its confidence rises; when it does not, the confidence drops
below any sane hold threshold so a human looks at it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache

from ai_service.currency import exponent
from ai_service.providers.base import Completion

_STRICT: dict[str, re.Pattern[str]] = {
    "vendorName": re.compile(r"^\s*(?:vendor|from|supplier)\s*[:#]\s*(.+?)\s*$", re.I | re.M),
    "invoiceNumber": re.compile(
        r"^\s*invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]*)\s*$", re.I | re.M
    ),
    "invoiceDate": re.compile(r"^\s*(?:invoice\s*)?date\s*[:#]\s*(\d{4}-\d{2}-\d{2})\s*$", re.I | re.M),
    "currency": re.compile(r"^\s*(?i:currency)\s*[:#]\s*([A-Z]{3})\s*$", re.M),
    "dueDate": re.compile(r"^\s*due\s*date\s*[:#]\s*(\d{4}-\d{2}-\d{2})\s*$", re.I | re.M),
}
# Output key for each pattern name (amounts are reported in minor units).
_KEYS = {"total": "totalMinor", "subtotal": "subtotalMinor", "tax": "taxMinor"}
STRICT_CONFIDENCE = 0.95

_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    )
}
# "¥" is also the Chinese yuan, so it is a weaker guess than "₩".
_SYMBOLS = {
    "$": ("USD", 0.5),
    "€": ("EUR", 0.8),
    "£": ("GBP", 0.8),
    "₹": ("INR", 0.8),
    "¥": ("JPY", 0.6),
    "₩": ("KRW", 0.8),
}
_KNOWN_CODES = (
    "USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "CHF", "SGD", "NZD",
    "KRW", "VND", "BHD", "KWD", "OMR", "JOD",
)  # fmt: skip
# An optional currency marker in front of an amount: a known ISO code or a symbol.
_CUR = r"(?:(?:" + "|".join(_KNOWN_CODES) + r")\s*|[$€£₹¥₩]\s*|Rs\.?\s*)"

_LOOSE_NUMBER = re.compile(
    r"\binvoice\s*(?:no\.?|number|num\.?|#|id)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/]{1,31})\b", re.I
)
_LOOSE_VENDOR = re.compile(
    r"\b(?:vendor|supplier|from|bill\s+from|remit\s+to)\s*[:#]\s*(.+?)\s*$", re.I | re.M
)
# "Due Date" is not the invoice date: the lookbehinds keep these off it.
_DATE_LABEL = r"(?<!due\s)(?<!due)\b(?:invoice\s+)?date\b[^\n\d]{0,20}"
_DUE_LABEL = r"\b(?:due\s+date|payment\s+due|due\s+on|due\s+by|pay\s+by|due)\b[^\n\d]{0,20}"
_ISO = r"(\d{4}-\d{2}-\d{2})\b"
_TEXT = r"(?:\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})|\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}))"
_SLASH = r"(\d{1,2})/(\d{1,2})/(\d{4})\b"
_ISO_DATE = re.compile(_DATE_LABEL + _ISO, re.I)
_TEXT_DATE = re.compile(_DATE_LABEL + _TEXT, re.I)
_SLASH_DATE = re.compile(_DATE_LABEL + _SLASH, re.I)
_DUE_ISO = re.compile(_DUE_LABEL + _ISO, re.I)
_DUE_TEXT = re.compile(_DUE_LABEL + _TEXT, re.I)
_DUE_SLASH = re.compile(_DUE_LABEL + _SLASH, re.I)
_NET_TERMS = re.compile(r"\bnet\s*(\d{1,3})\b(?:\s*days)?", re.I)

_SUMMARY_LINE = re.compile(
    r"(?i)\b(sub\s*-?\s*total|total|balance|amount\s+due|c?gst|sgst|igst|utgst|hst|pst|qst|vat|tax)\b"
)
# Words that make a line a header, a party, a summary or a payment detail rather than an invoice line.
_NOT_A_LINE = re.compile(
    r"(?i)\b(sub\s*-?\s*total|total|balance|amount\s+due|due|paid|payment|tax|vat|c?gst|sgst|igst|hst|"
    r"invoice|date|currency|vendor|supplier|bill\s+to|ship\s+to|remit|page|iban|discount|tel|phone|fax)\b"
)


def _number(e: int) -> str:
    """A grouped or plain number with exactly `e` decimals (none, and no trailing digits, when e is 0)."""
    whole = r"(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)"
    return whole + (rf"\.\d{{{e}}}(?!\d)" if e > 0 else r"(?![.,]?\d)")


@dataclass(frozen=True)
class _Patterns:
    """Every amount-bearing pattern, built for one currency exponent."""

    strict: dict[str, re.Pattern[str]]
    loose_total: re.Pattern[str]
    loose_subtotal: re.Pattern[str]
    tax_line: re.Pattern[str]
    line_full: re.Pattern[str]
    line_amount: re.Pattern[str]
    ends_with_amount: re.Pattern[str]


@lru_cache(maxsize=8)
def _patterns(e: int) -> _Patterns:
    amount = "(" + _number(e) + ")"
    signed = "(-?" + _number(e) + ")"
    strict_amount = r"([0-9][0-9,]*" + (rf"\.\d{{{e}}}" if e > 0 else "") + r")\s*$"
    # With no decimals any integer looks like an amount, so a yen line needs a currency marker.
    line_cur = _CUR if e == 0 else _CUR + "?"
    return _Patterns(
        strict={
            "total": re.compile(r"^\s*(?:amount\s+due|total)\s*[:#]\s*" + strict_amount, re.I | re.M),
            "subtotal": re.compile(r"^\s*sub\s*-?\s*total\s*[:#]\s*" + strict_amount, re.I | re.M),
            "tax": re.compile(r"^\s*(?:tax|vat|gst|sales\s+tax)\s*[:#]\s*" + strict_amount, re.I | re.M),
        },
        loose_total=re.compile(
            r"\b(?:total\s+due|amount\s+due|balance\s+due|grand\s+total|invoice\s+total|(?<!sub)(?<!sub\s)total)"
            r"\s*(?:\((?:[A-Z]{3})\))?\s*[:#]?\s*(?:[A-Z]{3}\s*)?[$€£¥₩]?\s*" + amount,
            re.I,
        ),
        loose_subtotal=re.compile(
            r"\bsub\s*-?\s*total\b\s*(?:\([A-Z]{3}\))?\s*[:#]?\s*" + _CUR + "?" + amount, re.I
        ),
        tax_line=re.compile(
            r"^\s*(?:[A-Za-z]+\s+)?(?:c?gst|sgst|igst|utgst|hst|pst|qst|vat|sales\s+tax|tax|consumption\s+tax)\b"
            r"(?:\s*(?:@|at)?\s*\(?\d{1,2}(?:\.\d{1,3})?\s*%\)?)?"
            r"\s*(?:\((?:[A-Z]{3})\))?\s*[:#]?\s*" + _CUR + "?" + amount + r"\s*$",
            re.I | re.M,
        ),
        line_full=re.compile(
            r"^\s*(?P<desc>.*?[A-Za-z].*?)\s+(?P<qty>\d{1,9}(?:\.\d{1,4})?)\s*(?:x\s*|@\s*)?"
            + _CUR
            + "?"
            + r"(?P<unit>"
            + signed[1:-1]
            + r")\s+"
            + _CUR
            + "?"
            + r"(?P<amount>"
            + signed[1:-1]
            + r")\s*$"
        ),
        line_amount=re.compile(
            r"^\s*(?P<desc>.*?[A-Za-z].*?)\s+" + line_cur + r"(?P<amount>" + signed[1:-1] + r")\s*$"
        ),
        ends_with_amount=re.compile(_number(e) + r"\s*$"),
    )


MAX_LINE_ITEMS = 200


def _to_minor(amount: str, e: int) -> str:
    """ "1,234.50" -> "123450" with 2 decimals, "12,000" -> "12000" with none."""
    neg = amount.startswith("-")
    whole, _, frac = amount.lstrip("-").replace(",", "").partition(".")
    minor = int(whole) * 10**e + int((frac or "0").ljust(e, "0")[:e] or "0")
    return str(-minor if neg else minor)


def _iso(y: int, m: int, d: int) -> str | None:
    try:
        return date(y, m, d).isoformat()
    except ValueError:
        return None


def _month(name: str) -> int | None:
    return _MONTHS.get(name[:3].lower())


def _loose_vendor(text: str) -> tuple[str, float] | None:
    m = _LOOSE_VENDOR.search(text)
    if m:
        return m.group(1), 0.7
    # Letterheads put the vendor on the first line. It is a guess, so it scores
    # below any sane hold threshold and a human confirms it.
    for line in text.splitlines():
        candidate = line.strip()
        if candidate and not re.fullmatch(r"(?i)(tax\s+)?invoice|bill|receipt", candidate):
            return candidate[:256], 0.4
    return None


def _loose_number(text: str) -> tuple[str, float] | None:
    for m in _LOOSE_NUMBER.finditer(text):
        value = m.group(1)
        # "Invoice Date" and "Invoice Total" are labels, not numbers.
        if value.lower() not in {"date", "total", "no", "number"} and any(c.isdigit() for c in value):
            return value, 0.75
    return None


def _date_from(
    text: str, iso_re: re.Pattern[str], text_re: re.Pattern[str], slash_re: re.Pattern[str]
) -> tuple[str, float] | None:
    m = iso_re.search(text)
    if m:
        y, mo, d = (int(p) for p in m.group(1).split("-"))
        iso = _iso(y, mo, d)
        if iso:
            return iso, 0.85
    m = text_re.search(text)
    if m:
        if m.group(1):
            day, mon, year = m.group(1), m.group(2), m.group(3)
        else:
            mon, day, year = m.group(4), m.group(5), m.group(6)
        month = _month(mon)
        iso = _iso(int(year), month, int(day)) if month else None
        if iso:
            return iso, 0.8
    m = slash_re.search(text)
    if m:
        # 03/04/2026 is March 4th in the US and April 3rd almost everywhere else.
        a, b, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if a > 12:
            iso, conf = _iso(year, b, a), 0.7
        elif b > 12:
            iso, conf = _iso(year, a, b), 0.7
        else:
            iso, conf = _iso(year, a, b), 0.4
        if iso:
            return iso, conf
    return None


def _loose_date(text: str) -> tuple[str, float] | None:
    return _date_from(text, _ISO_DATE, _TEXT_DATE, _SLASH_DATE)


def _loose_due_date(text: str) -> tuple[str, float] | None:
    return _date_from(text, _DUE_ISO, _DUE_TEXT, _DUE_SLASH)


def _net_terms_due(text: str, invoice_date: str | None, date_confidence: float) -> tuple[str, float] | None:
    """ "Net 30" counted from the invoice date. Only as good as the invoice date it builds on."""
    m = _NET_TERMS.search(text)
    if not m or not invoice_date:
        return None
    days = int(m.group(1))
    if days > 365:
        return None
    due = date.fromisoformat(invoice_date) + timedelta(days=days)
    return due.isoformat(), min(0.65, date_confidence)


def _loose_currency(text: str) -> tuple[str, float] | None:
    codes = [c for c in _KNOWN_CODES if re.search(rf"\b{c}\b", text)]
    if len(codes) == 1:
        return codes[0], 0.85
    symbols = [s for s in _SYMBOLS if s in text]
    if len(symbols) == 1:
        return _SYMBOLS[symbols[0]]
    return None


def _loose_subtotal(text: str, e: int) -> tuple[str, float] | None:
    m = _patterns(e).loose_subtotal.search(text)
    return (_to_minor(m.group(1), e), 0.8) if m else None


def _loose_tax(text: str, e: int) -> tuple[str, float] | None:
    """One tax line, or several (CGST + SGST, GST + PST) summed. A total that includes tax is not tax."""
    amounts = [
        int(_to_minor(m.group(1), e))
        for m in _patterns(e).tax_line.finditer(text)
        if not re.search(r"(?i)\b(incl|including|excl|excluding|total|invoice|number|id|no)\b", m.group(0))
    ]
    if not amounts:
        return None
    return str(sum(amounts)), 0.8 if len(amounts) == 1 else 0.7


def _line_items(text: str, e: int) -> list[dict[str, str | float | None]]:
    """Body lines before the first summary line (subtotal, tax, total)."""
    p = _patterns(e)
    items: list[dict[str, str | float | None]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _SUMMARY_LINE.search(line) and p.ends_with_amount.search(line):
            break
        if _NOT_A_LINE.search(line):
            continue
        full = p.line_full.match(line)
        if full:
            qty, unit, amount = (
                full.group("qty"),
                _to_minor(full.group("unit"), e),
                _to_minor(full.group("amount"), e),
            )
            desc = full.group("desc")
            # quantity x unit price = amount, to the cent, is strong evidence the columns were read right.
            product = int(unit) * _quantity_milli(qty)
            consistent = abs(product - int(amount) * 1000) < 500 * max(1, len(qty))
            if not consistent and e == 0 and not re.search(_CUR, line):
                # Three bare integers that do not multiply out are more likely a phone number than a line.
                continue
            conf = 0.85 if consistent else 0.5
            items.append(_line(desc, qty, unit, amount, conf))
        else:
            only = p.line_amount.match(line)
            if only is None:
                continue
            items.append(_line(only.group("desc"), None, None, _to_minor(only.group("amount"), e), 0.6))
        if len(items) >= MAX_LINE_ITEMS:
            break
    return items


def _quantity_milli(qty: str) -> int:
    whole, _, frac = qty.partition(".")
    return int(whole) * 1000 + int((frac + "000")[:3])


def _line(
    desc: str, qty: str | None, unit: str | None, amount: str | None, conf: float
) -> dict[str, str | float | None]:
    description = re.sub(r"[\s.:\-|]+$", "", desc.strip())[:500] or "(no description)"
    return {
        "description": description,
        "quantity": qty,
        "unitPriceMinor": unit,
        "amountMinor": amount,
        "confidence": conf,
    }


def _cross_check(
    fields: dict[str, dict[str, str | float | None]], lines: list[dict[str, str | float | None]]
) -> None:
    """Corroborate or doubt the total with the arithmetic printed on the same page."""
    total = fields["totalMinor"]["value"]
    if total is None:
        return
    tax = fields["taxMinor"]["value"]
    base = fields["subtotalMinor"]["value"]
    if base is None and lines and all(li["amountMinor"] is not None for li in lines):
        base = str(sum(int(str(li["amountMinor"])) for li in lines))
    if base is None:
        return
    expected = int(str(base)) + (int(str(tax)) if tax is not None else 0)
    conf = float(fields["totalMinor"]["confidence"] or 0.0)
    if expected == int(str(total)):
        fields["totalMinor"]["confidence"] = max(conf, 0.9)
    elif tax is not None and fields["subtotalMinor"]["value"] is not None:
        # A printed subtotal and tax that do not add up to the printed total: someone must look.
        # (A subtotal alone can legitimately differ: shipping, discounts, rounding.)
        fields["totalMinor"]["confidence"] = min(conf, 0.5)


def _loose_total(text: str, e: int) -> tuple[str, float] | None:
    matches = list(_patterns(e).loose_total.finditer(text))
    if not matches:
        return None
    # Prefer the most specific label ("balance due" beats a bare "total"), then the last one on the page.
    ranked = sorted(
        matches, key=lambda m: (bool(re.match(r"(?i)(total|grand|invoice)", m.group(0))), -m.start())
    )
    return _to_minor(ranked[0].group(1), e), 0.75


_LOOSE: dict[str, Callable[[str], tuple[str, float] | None]] = {
    "vendorName": _loose_vendor,
    "invoiceNumber": _loose_number,
    "invoiceDate": _loose_date,
    "currency": _loose_currency,
    "dueDate": _loose_due_date,
}
_LOOSE_AMOUNT: dict[str, Callable[[str, int], tuple[str, float] | None]] = {
    "total": _loose_total,
    "subtotal": _loose_subtotal,
    "tax": _loose_tax,
}
_FIELD_ORDER = (
    "vendorName", "invoiceNumber", "invoiceDate", "currency", "total", "subtotal", "tax", "dueDate",
)  # fmt: skip


class HeuristicProvider:
    name = "heuristic"
    model = "regex-v4"

    def complete(self, *, task: str, prompt: str) -> Completion:
        if task != "extract_invoice_fields":
            return Completion(provider=self.name, model=self.model, text="{}")
        fields: dict[str, dict[str, str | float | None]] = {}
        e = 2
        for name in _FIELD_ORDER:
            key = _KEYS.get(name, name)
            if name == "total":
                # The currency is known by now; read every amount with its decimal places.
                currency = fields["currency"]["value"]
                e = exponent(currency if isinstance(currency, str) else None)
            pattern = _patterns(e).strict[name] if name in _KEYS else _STRICT[name]
            m = pattern.search(prompt)
            if m is not None:
                value = _to_minor(m.group(1), e) if name in _KEYS else m.group(1)
                fields[key] = {"value": value, "confidence": STRICT_CONFIDENCE}
                continue
            loose = _LOOSE_AMOUNT[name](prompt, e) if name in _KEYS else _LOOSE[name](prompt)
            if loose is None:
                fields[key] = {"value": None, "confidence": 0.0}
            else:
                fields[key] = {"value": loose[0], "confidence": loose[1]}
        if fields["dueDate"]["value"] is None:
            invoice_date = fields["invoiceDate"]
            net = _net_terms_due(
                prompt,
                invoice_date["value"] if isinstance(invoice_date["value"], str) else None,
                float(invoice_date["confidence"] or 0.0),
            )
            if net is not None:
                fields["dueDate"] = {"value": net[0], "confidence": net[1]}
        lines = _line_items(prompt, e)
        _cross_check(fields, lines)
        out: dict[str, object] = {**fields, "lineItems": lines}
        return Completion(provider=self.name, model=self.model, text=json.dumps(out, sort_keys=True))
