"""Render a LabelRecord into synthetic invoice text for the heuristic provider."""

from __future__ import annotations

from invoiceiq_data.labels import LabelRecord


def render(label: LabelRecord) -> str:
    """Turn a label into a labelled-field invoice that the heuristic provider reads."""
    lines = [
        f"Vendor: {label.vendor_id}",
        f"Invoice No: {label.invoice_number}",
        f"Date: {label.invoice_date}",
        f"Currency: {label.currency}",
        f"Total: {_format_amount(label.total_minor, label.currency)}",
    ]
    return "\n".join(lines) + "\n"


def _format_amount(minor: int, currency: str) -> str:
    """Format an integer minor-unit amount using the currency's exponent."""
    from ai_service.currency import exponent

    exp = exponent(currency)
    if exp == 0:
        return str(minor)
    divisor = 10**exp
    whole, frac = divmod(minor, divisor)
    return f"{whole}.{frac:0{exp}d}"
