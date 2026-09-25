from __future__ import annotations

import json

import pytest

from invoiceiq_data.generator import generate, to_jsonl
from invoiceiq_data.labels import LabelRecord
from invoiceiq_data.paths import SPLITS_DIR
from invoiceiq_data.splits import assign_split, bucket, family_leaks, split_records
from invoiceiq_data.taxonomy import load_taxonomy

TAX = load_taxonomy()
RECORDS = generate(TAX)


def test_generation_is_deterministic() -> None:
    assert to_jsonl(generate(TAX)) == to_jsonl(RECORDS)


def test_different_seed_differs() -> None:
    assert to_jsonl(generate(TAX, seed=1)) != to_jsonl(RECORDS)


def test_every_family_has_exactly_one_clean_doc() -> None:
    clean = [r.family_id for r in RECORDS if not r.is_attack]
    assert len(clean) == len(set(clean)) == 150


def test_doc_ids_are_unique() -> None:
    ids = [r.doc_id for r in RECORDS]
    assert len(ids) == len(set(ids))


def test_split_is_family_safe() -> None:
    assert family_leaks(split_records(RECORDS)) == []


def test_family_leak_detector_works() -> None:
    splits = split_records(RECORDS)
    victim = splits["train"][0]
    splits["test"].append(victim.model_copy(update={"split": "test"}))
    assert family_leaks(splits) == [victim.family_id]


def test_split_ratios_are_roughly_80_10_10() -> None:
    families = [f"FAM-{i:08x}" for i in range(5000)]
    counts = {s: sum(assign_split(f) == s for f in families) for s in ("train", "dev", "test")}
    assert 3800 < counts["train"] < 4200
    assert 350 < counts["dev"] < 650
    assert 350 < counts["test"] < 650


def test_assignment_is_stable_when_families_are_added() -> None:
    small = {r.family_id: assign_split(r.family_id) for r in generate(TAX, families=20)}
    large = {r.family_id: assign_split(r.family_id) for r in generate(TAX, families=150)}
    assert all(large[f] == s for f, s in small.items())


def test_salt_changes_assignment() -> None:
    fams = [r.family_id for r in RECORDS]
    assert [bucket(f) for f in fams] != [bucket(f, salt="other") for f in fams]


@pytest.mark.parametrize("ratios", [(50, 50), (80, 10, 11), (110, -5, -5)])
def test_bad_ratios_are_rejected(ratios: tuple[int, ...]) -> None:
    with pytest.raises(ValueError, match="ratios"):
        assign_split("FAM-00000000", ratios=ratios)


def test_committed_splits_match_generation() -> None:
    for name, rows in split_records(RECORDS).items():
        committed = [json.loads(line) for line in (SPLITS_DIR / f"{name}.jsonl").read_text().splitlines()]
        assert committed == [json.loads(r.model_dump_json()) for r in rows]


def test_every_split_contains_attacks_and_clean_docs() -> None:
    for name, rows in split_records(RECORDS).items():
        assert any(r.is_attack for r in rows), name
        assert any(not r.is_attack for r in rows), name


def test_records_roundtrip_through_json() -> None:
    for r in RECORDS[:25]:
        assert LabelRecord.model_validate_json(r.model_dump_json()) == r
