"""Label schema for synthetic invoices.

One *family* is one underlying legitimate invoice. Its clean baseline and every
red-team variant derived from it share a family_id, which is what makes
splitting leak-free (see splits.py).
"""

from __future__ import annotations

import json
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from invoiceiq_data.catalog import load_catalog

Outcome = Literal["PASS", "HOLD", "EXCEPTION", "REJECTED"]
Split = Literal["train", "dev", "test"]


class LabelRecord(BaseModel):
    """Ground truth for one synthetic invoice document."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    doc_id: str = Field(pattern=r"^DOC-[0-9a-f]{12}$")
    family_id: str = Field(pattern=r"^FAM-[0-9a-f]{8}$")
    variant_id: str | None = Field(default=None, pattern=r"^RT-[A-Z]{3}-\d{2}$")
    is_attack: bool
    vendor_id: str = Field(pattern=r"^VEN-\d{4}$")
    invoice_number: str = Field(min_length=1, max_length=64)
    invoice_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    total_minor: int = Field(ge=0)
    expected_reason_codes: tuple[str, ...] = ()
    expected_outcome: Outcome

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.is_attack != (self.variant_id is not None):
            raise ValueError("is_attack must be true exactly when variant_id is set")
        if not self.is_attack and (self.expected_reason_codes or self.expected_outcome != "PASS"):
            raise ValueError("clean documents must PASS with no reason codes")
        if self.is_attack and (not self.expected_reason_codes or self.expected_outcome == "PASS"):
            raise ValueError("attack documents need reason codes and a non-PASS outcome")
        catalog = load_catalog()
        for code in self.expected_reason_codes:
            if code not in catalog:
                raise ValueError(f"unknown reason code {code}")
            if self.expected_outcome not in catalog[code].allowed_outcomes:
                raise ValueError(f"{code} does not allow outcome {self.expected_outcome}")
        return self


class SplitRecord(LabelRecord):
    split: Split


def label_json_schema() -> str:
    schema = LabelRecord.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = "https://github.com/Uday-Varik/InvoiceIQ/data/schemas/label.schema.json"
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"
