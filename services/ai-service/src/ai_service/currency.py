"""ISO 4217 minor-unit exponents: how many decimals each currency's minor unit has.

core-api owns the table (services/core-api/src/domain/currency.ts) and exports
it to packages/contracts/catalog/reason-codes.json; a guardrail keeps this copy
identical. Currencies with the usual 2 decimals are left out.
"""

from __future__ import annotations

DEFAULT_EXPONENT = 2

EXPONENTS: dict[str, int] = {
    "BIF": 0,
    "CLP": 0,
    "DJF": 0,
    "GNF": 0,
    "ISK": 0,
    "JPY": 0,
    "KMF": 0,
    "KRW": 0,
    "PYG": 0,
    "RWF": 0,
    "UGX": 0,
    "UYI": 0,
    "VND": 0,
    "VUV": 0,
    "XAF": 0,
    "XOF": 0,
    "XPF": 0,
    "BHD": 3,
    "IQD": 3,
    "JOD": 3,
    "KWD": 3,
    "LYD": 3,
    "OMR": 3,
    "TND": 3,
    "CLF": 4,
    "UYW": 4,
}


def exponent(currency: str | None) -> int:
    """Decimal places of the currency's minor unit (2 when unknown or missing)."""
    return EXPONENTS.get(currency or "", DEFAULT_EXPONENT)
