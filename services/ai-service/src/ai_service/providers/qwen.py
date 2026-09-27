"""Qwen provider via OpenRouter API."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from ai_service.providers.base import Completion, ProviderError

SYSTEM_PROMPT = """\
You are an invoice data extraction system. Extract structured fields from the \
invoice text the user provides.

Return ONLY a JSON object with these keys. Every key must be present.

For each header field, return {"value": <string or null>, "confidence": <0.0-1.0>}.
Set value to null and confidence to 0.0 when the field is not found.

Required keys:
  vendorName   - the supplier / vendor name
  invoiceNumber - the invoice identifier
  invoiceDate  - date in YYYY-MM-DD format
  currency     - ISO 4217 three-letter code (e.g. "USD", "EUR")
  totalMinor   - total amount in minor units as a string (e.g. cents: "1050" for $10.50)
  subtotalMinor - subtotal before tax in minor units, or null
  taxMinor     - tax amount in minor units, or null
  dueDate      - payment due date in YYYY-MM-DD, or null

Optional key:
  lineItems    - array of line items, each with:
    description (string), quantity (string or null, e.g. "2"),
    unitPriceMinor (string or null), amountMinor (string or null),
    confidence (0.0-1.0)

For amounts: convert to minor units using the currency's standard subunit \
(e.g. USD/EUR use cents, so $125.99 = "12599"; JPY has no subunit, so ¥1000 = "1000").

Confidence guidelines:
  1.0  - field is explicitly stated and unambiguous
  0.85-0.95 - field is present but requires interpretation
  0.4-0.8  - field is inferred or partially visible
  0.0  - field is not found

Do not include any text outside the JSON object. No markdown fences."""


class QwenProvider:
    """Qwen extraction via OpenRouter API."""

    name = "qwen"
    _model = "qwen/qwen3-235b-a22b"
    _api_base = "https://openrouter.ai/api/v1"

    def __init__(self, api_key: str) -> None:
        if not api_key or not api_key.strip():
            raise ProviderError("OPENROUTER_API_KEY is empty")
        self._api_key = api_key

    def complete(self, *, task: str, prompt: str) -> Completion:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 2048,
            "temperature": 0.1,
        }

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        req = urllib.request.Request(  # noqa: S310
            f"{self._api_base}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as response:  # noqa: S310
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise ProviderError(f"OpenRouter API error: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError(f"OpenRouter returned invalid JSON: {exc}") from exc

        try:
            message = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"unexpected response structure: {exc}") from exc

        cleaned = _strip_markdown_fences(message)
        return Completion(provider=self.name, model=self._model, text=cleaned)


def _strip_markdown_fences(text: str) -> str:
    """Strip markdown code fences that LLMs sometimes wrap JSON in."""
    stripped = text.strip()
    match = re.match(r"^```(?:json)?\s*\n(.*)\n```\s*$", stripped, re.DOTALL)
    if match:
        return match.group(1).strip()
    return stripped
