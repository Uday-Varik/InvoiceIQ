"""Deterministic, family-safe train/dev/test splitting.

The split is a pure function of (salt, family_id), so every document in a family
(the clean invoice and all its red-team variants) lands in the same split. That
prevents the classic leak where a model trains on a variant and is tested on its
sibling. Adding or removing families never moves existing families.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Sequence

from invoiceiq_data.labels import LabelRecord, Split, SplitRecord

DEFAULT_SALT = "invoiceiq-split-v1"
DEFAULT_RATIOS: tuple[int, int, int] = (80, 10, 10)


def bucket(family_id: str, salt: str = DEFAULT_SALT) -> int:
    digest = hashlib.sha256(f"{salt}:{family_id}".encode()).hexdigest()
    return int(digest[:8], 16) % 100


def assign_split(family_id: str, salt: str = DEFAULT_SALT, ratios: Sequence[int] = DEFAULT_RATIOS) -> Split:
    if len(ratios) != 3 or sum(ratios) != 100 or any(r < 0 for r in ratios):
        raise ValueError("ratios must be three non-negative integers summing to 100")
    b = bucket(family_id, salt)
    if b < ratios[0]:
        return "train"
    if b < ratios[0] + ratios[1]:
        return "dev"
    return "test"


def split_records(
    records: Iterable[LabelRecord], salt: str = DEFAULT_SALT, ratios: Sequence[int] = DEFAULT_RATIOS
) -> dict[Split, list[SplitRecord]]:
    out: dict[Split, list[SplitRecord]] = {"train": [], "dev": [], "test": []}
    for r in records:
        split = assign_split(r.family_id, salt, ratios)
        out[split].append(SplitRecord(**r.model_dump(), split=split))
    for split in out:
        out[split].sort(key=lambda r: r.doc_id)
    return out


def family_leaks(splits: dict[Split, list[SplitRecord]]) -> list[str]:
    """Families that appear in more than one split (must be empty)."""
    seen: dict[str, set[str]] = {}
    for split, records in splits.items():
        for r in records:
            seen.setdefault(r.family_id, set()).add(split)
    return sorted(f for f, s in seen.items() if len(s) > 1)
