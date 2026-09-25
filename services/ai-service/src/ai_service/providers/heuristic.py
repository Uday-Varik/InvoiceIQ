"""Deterministic, offline provider used in development and as the replay baseline.

It pulls fields with regular expressions and reports honest confidences: 0.95
when a labelled field is found, 0.0 when it is not. A real model provider plugs
in behind the same interface in a later phase.
"""

from __future__ import annotations

import json
import re

from ai_service.providers.base import Completion

_PATTERNS: dict[str, re.Pattern[str]] = {
    "vendorName": re.compile(r"^\s*(?:vendor|from|supplier)\s*[:#]\s*(.+?)\s*$", re.I | re.M),
    "invoiceNumber": re.compile(
        r"^\s*invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]*)\s*$", re.I | re.M
    ),
    "invoiceDate": re.compile(r"^\s*(?:invoice\s*)?date\s*[:#]\s*(\d{4}-\d{2}-\d{2})\s*$", re.I | re.M),
    "currency": re.compile(r"^\s*(?i:currency)\s*[:#]\s*([A-Z]{3})\s*$", re.M),
    "total": re.compile(r"^\s*(?:amount\s+due|total)\s*[:#]\s*([0-9][0-9,]*\.\d{2})\s*$", re.I | re.M),
}


def _to_minor(amount: str) -> str:
    whole, frac = amount.replace(",", "").split(".")
    return str(int(whole) * 100 + int(frac))


class HeuristicProvider:
    name = "heuristic"
    model = "regex-v1"

    def complete(self, *, task: str, prompt: str) -> Completion:
        if task != "extract_invoice_fields":
            return Completion(provider=self.name, model=self.model, text="{}")
        fields: dict[str, dict[str, str | float | None]] = {}
        for name, pattern in _PATTERNS.items():
            m = pattern.search(prompt)
            key = "totalMinor" if name == "total" else name
            if m is None:
                fields[key] = {"value": None, "confidence": 0.0}
            else:
                value = _to_minor(m.group(1)) if name == "total" else m.group(1)
                fields[key] = {"value": value, "confidence": 0.95}
        return Completion(provider=self.name, model=self.model, text=json.dumps(fields, sort_keys=True))
