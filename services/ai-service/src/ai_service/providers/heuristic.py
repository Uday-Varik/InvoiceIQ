"""Deterministic, offline provider used in development and as the replay baseline.

It pulls fields with regular expressions and reports honest confidences. A
labelled `Field: value` line scores 0.95. When no such line exists, looser
patterns written for real PDF text layers ("Invoice # INV-1 Date 14 Mar 2026",
"Balance due $1,200.00") are tried and score lower, because each one involves a
guess (which number is the total, which currency "$" means). A missing field
scores 0.0. A real model provider plugs in behind the same interface later.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import date

from ai_service.providers.base import Completion

_STRICT: dict[str, re.Pattern[str]] = {
    "vendorName": re.compile(r"^\s*(?:vendor|from|supplier)\s*[:#]\s*(.+?)\s*$", re.I | re.M),
    "invoiceNumber": re.compile(
        r"^\s*invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]*)\s*$", re.I | re.M
    ),
    "invoiceDate": re.compile(r"^\s*(?:invoice\s*)?date\s*[:#]\s*(\d{4}-\d{2}-\d{2})\s*$", re.I | re.M),
    "currency": re.compile(r"^\s*(?i:currency)\s*[:#]\s*([A-Z]{3})\s*$", re.M),
    "total": re.compile(r"^\s*(?:amount\s+due|total)\s*[:#]\s*([0-9][0-9,]*\.\d{2})\s*$", re.I | re.M),
}
STRICT_CONFIDENCE = 0.95

_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    )
}
_AMOUNT = r"([0-9]{1,3}(?:,[0-9]{3})+\.\d{2}|[0-9]+\.\d{2})"
_SYMBOLS = {"$": ("USD", 0.5), "€": ("EUR", 0.8), "£": ("GBP", 0.8)}
_KNOWN_CODES = ("USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "CHF", "SGD", "NZD")

_LOOSE_NUMBER = re.compile(
    r"\binvoice\s*(?:no\.?|number|num\.?|#|id)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/]{1,31})\b", re.I
)
_LOOSE_TOTAL = re.compile(
    r"\b(?:total\s+due|amount\s+due|balance\s+due|grand\s+total|invoice\s+total|(?<!sub)(?<!sub\s)total)"
    r"\s*(?:\((?:[A-Z]{3})\))?\s*[:#]?\s*(?:[A-Z]{3}\s*)?[$€£]?\s*" + _AMOUNT,
    re.I,
)
_LOOSE_VENDOR = re.compile(
    r"\b(?:vendor|supplier|from|bill\s+from|remit\s+to)\s*[:#]\s*(.+?)\s*$", re.I | re.M
)
_ISO_DATE = re.compile(r"\b(?:invoice\s+)?date\b[^\n\d]{0,20}(\d{4}-\d{2}-\d{2})\b", re.I)
_TEXT_DATE = re.compile(
    r"\b(?:invoice\s+)?date\b[^\n\d]{0,20}"
    r"(?:\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})|\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}))",
    re.I,
)
_SLASH_DATE = re.compile(r"\b(?:invoice\s+)?date\b[^\n\d]{0,20}(\d{1,2})/(\d{1,2})/(\d{4})\b", re.I)


def _to_minor(amount: str) -> str:
    whole, frac = amount.replace(",", "").split(".")
    return str(int(whole) * 100 + int(frac))


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


def _loose_date(text: str) -> tuple[str, float] | None:
    m = _ISO_DATE.search(text)
    if m:
        y, mo, d = (int(p) for p in m.group(1).split("-"))
        iso = _iso(y, mo, d)
        if iso:
            return iso, 0.85
    m = _TEXT_DATE.search(text)
    if m:
        if m.group(1):
            day, mon, year = m.group(1), m.group(2), m.group(3)
        else:
            mon, day, year = m.group(4), m.group(5), m.group(6)
        month = _month(mon)
        iso = _iso(int(year), month, int(day)) if month else None
        if iso:
            return iso, 0.8
    m = _SLASH_DATE.search(text)
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


def _loose_currency(text: str) -> tuple[str, float] | None:
    codes = [c for c in _KNOWN_CODES if re.search(rf"\b{c}\b", text)]
    if len(codes) == 1:
        return codes[0], 0.85
    symbols = [s for s in _SYMBOLS if s in text]
    if len(symbols) == 1:
        return _SYMBOLS[symbols[0]]
    return None


def _loose_total(text: str) -> tuple[str, float] | None:
    matches = list(_LOOSE_TOTAL.finditer(text))
    if not matches:
        return None
    # Prefer the most specific label ("balance due" beats a bare "total"), then the last one on the page.
    ranked = sorted(
        matches, key=lambda m: (bool(re.match(r"(?i)(total|grand|invoice)", m.group(0))), -m.start())
    )
    return _to_minor(ranked[0].group(1)), 0.75


_LOOSE: dict[str, Callable[[str], tuple[str, float] | None]] = {
    "vendorName": _loose_vendor,
    "invoiceNumber": _loose_number,
    "invoiceDate": _loose_date,
    "currency": _loose_currency,
    "total": _loose_total,
}


class HeuristicProvider:
    name = "heuristic"
    model = "regex-v2"

    def complete(self, *, task: str, prompt: str) -> Completion:
        if task != "extract_invoice_fields":
            return Completion(provider=self.name, model=self.model, text="{}")
        fields: dict[str, dict[str, str | float | None]] = {}
        for name, pattern in _STRICT.items():
            key = "totalMinor" if name == "total" else name
            m = pattern.search(prompt)
            if m is not None:
                value = _to_minor(m.group(1)) if name == "total" else m.group(1)
                fields[key] = {"value": value, "confidence": STRICT_CONFIDENCE}
                continue
            loose = _LOOSE[name](prompt)
            if loose is None:
                fields[key] = {"value": None, "confidence": 0.0}
            else:
                fields[key] = {"value": loose[0], "confidence": loose[1]}
        return Completion(provider=self.name, model=self.model, text=json.dumps(fields, sort_keys=True))
