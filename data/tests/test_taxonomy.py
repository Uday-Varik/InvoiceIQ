from __future__ import annotations

from collections import Counter

import pytest

from invoiceiq_data.catalog import load_catalog
from invoiceiq_data.taxonomy import Taxonomy, load_taxonomy, validate_taxonomy

TAX = load_taxonomy()


def test_taxonomy_is_valid() -> None:
    assert validate_taxonomy(TAX) == []


def test_has_61_variants_in_8_categories() -> None:
    assert len(TAX.variants) == 61
    assert len(TAX.categories) == 8


def test_every_category_has_at_least_seven_variants() -> None:
    assert min(len(c.variants) for c in TAX.categories) >= 7


def test_every_reason_code_is_exercised_by_some_variant() -> None:
    used = {code for v in TAX.variants for code in v.expected_reason_codes}
    assert used == set(load_catalog())


def test_ai_only_variants_always_hold() -> None:
    for v in TAX.variants:
        if v.detection == "ai":
            assert v.expected_outcome == "HOLD", v.id


def test_prompt_injection_never_passes_or_approves() -> None:
    pin = next(c for c in TAX.categories if c.id == "prompt_injection")
    assert {v.expected_outcome for v in pin.variants} == {"HOLD"}


def test_detection_mix() -> None:
    counts = Counter(v.detection for v in TAX.variants)
    assert counts["deterministic"] > 0
    assert counts["ai"] > 0
    assert counts["both"] > 0


def _mutated(**changes: object) -> Taxonomy:
    raw = TAX.model_dump()
    variant = raw["categories"][0]["variants"][0]
    variant.update(changes)
    return Taxonomy.model_validate(raw)


@pytest.mark.parametrize(
    ("changes", "needle"),
    [
        ({"expected_reason_codes": ("NOT_A_CODE",)}, "unknown reason code"),
        (
            {"expected_reason_codes": ("AI_ANOMALY_SUSPECTED",), "expected_outcome": "REJECTED"},
            "does not allow",
        ),
        ({"expected_reason_codes": ("DUPLICATE_EXACT",), "detection": "ai"}, "detection=ai"),
        ({"id": "RT-DUP-02"}, "duplicate variant ids"),
        ({"slug": "cross_channel_resubmission"}, "duplicate slugs"),
        ({"id": "RT-BNK-99"}, "mixes id prefixes"),
    ],
)
def test_validator_catches(changes: dict[str, object], needle: str) -> None:
    problems = validate_taxonomy(_mutated(**changes))
    assert any(needle in p for p in problems), problems


def test_validator_catches_wrong_count() -> None:
    assert validate_taxonomy(TAX, expected_count=60) != []
