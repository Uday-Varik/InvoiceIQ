"""Red-team taxonomy loader and validator."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from invoiceiq_data.catalog import load_catalog
from invoiceiq_data.paths import TAXONOMY

EXPECTED_VARIANT_COUNT = 61


class Variant(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^RT-[A-Z]{3}-\d{2}$")
    slug: str = Field(pattern=r"^[a-z][a-z0-9_]+$")
    description: str = Field(min_length=10)
    expected_reason_codes: tuple[str, ...] = Field(min_length=1)
    expected_outcome: Literal["HOLD", "EXCEPTION", "REJECTED"]
    detection: Literal["deterministic", "ai", "both"]


class Category(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^[a-z][a-z_]+$")
    title: str
    variants: tuple[Variant, ...] = Field(min_length=1)


class Taxonomy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1]
    categories: tuple[Category, ...]

    @property
    def variants(self) -> list[Variant]:
        return [v for c in self.categories for v in c.variants]


def load_taxonomy(path: Path = TAXONOMY) -> Taxonomy:
    return Taxonomy.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))


def validate_taxonomy(tax: Taxonomy, expected_count: int = EXPECTED_VARIANT_COUNT) -> list[str]:
    """Return every problem found; an empty list means the taxonomy is sound."""
    problems: list[str] = []
    catalog = load_catalog()
    variants = tax.variants
    if len(variants) != expected_count:
        problems.append(f"expected {expected_count} variants, found {len(variants)}")
    for kind, values in (("variant id", [v.id for v in variants]), ("slug", [v.slug for v in variants])):
        dupes = sorted({x for x in values if values.count(x) > 1})
        if dupes:
            problems.append(f"duplicate {kind}s: {dupes}")
    cat_ids = [c.id for c in tax.categories]
    if len(set(cat_ids)) != len(cat_ids):
        problems.append("duplicate category ids")
    for v in variants:
        sources = set()
        for code in v.expected_reason_codes:
            reason = catalog.get(code)
            if reason is None:
                problems.append(f"{v.id}: unknown reason code {code}")
                continue
            sources.add(reason.source)
            # Mirrors the lifecycle gate: every reason on a transition must allow its outcome.
            if v.expected_outcome not in reason.allowed_outcomes:
                problems.append(f"{v.id}: {code} does not allow {v.expected_outcome}")
        expected_sources = {"deterministic": {"deterministic"}, "ai": {"ai"}, "both": {"deterministic", "ai"}}
        if sources and sources != expected_sources[v.detection]:
            problems.append(f"{v.id}: detection={v.detection} but codes come from {sorted(sources)}")
    for c in tax.categories:
        prefixes = {v.id[3:6] for v in c.variants}
        if len(prefixes) != 1:
            problems.append(f"category {c.id} mixes id prefixes {sorted(prefixes)}")
    return problems
