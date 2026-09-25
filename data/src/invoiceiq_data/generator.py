"""Seeded synthetic label generator.

Produces one clean baseline per family plus 0-3 red-team variants sampled from
the taxonomy. Only labels are generated here; rendering documents from labels is
a Phase 1 task. Output is byte-for-byte deterministic for a given seed.
"""

from __future__ import annotations

import hashlib
import random

from invoiceiq_data.labels import LabelRecord
from invoiceiq_data.taxonomy import Taxonomy

DEFAULT_SEED = 1337
DEFAULT_FAMILIES = 150
CURRENCIES = ("USD", "USD", "USD", "EUR", "GBP", "CAD")


def _hex(*parts: str, n: int) -> str:
    return hashlib.sha256(":".join(parts).encode()).hexdigest()[:n]


def generate(
    taxonomy: Taxonomy, seed: int = DEFAULT_SEED, families: int = DEFAULT_FAMILIES
) -> list[LabelRecord]:
    rng = random.Random(seed)  # noqa: S311 - reproducible synthetic data, not crypto
    variants = sorted(taxonomy.variants, key=lambda v: v.id)
    records: list[LabelRecord] = []
    for i in range(families):
        family_id = f"FAM-{_hex(str(seed), str(i), n=8)}"
        base = {
            "family_id": family_id,
            "vendor_id": f"VEN-{rng.randint(1, 400):04d}",
            "invoice_number": f"INV-{rng.randint(2025, 2026)}-{rng.randint(1, 99999):05d}",
            "invoice_date": f"2026-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
            "currency": rng.choice(CURRENCIES),
            "total_minor": rng.randint(1_000, 25_000_000),
        }
        records.append(
            LabelRecord(
                doc_id=f"DOC-{_hex(family_id, 'clean', n=12)}",
                is_attack=False,
                expected_outcome="PASS",
                **base,
            )
        )
        for v in rng.sample(variants, k=rng.randint(0, 3)):
            records.append(
                LabelRecord(
                    doc_id=f"DOC-{_hex(family_id, v.id, n=12)}",
                    variant_id=v.id,
                    is_attack=True,
                    expected_reason_codes=v.expected_reason_codes,
                    expected_outcome=v.expected_outcome,
                    **base,
                )
            )
    return sorted(records, key=lambda r: r.doc_id)


def to_jsonl(records: list[LabelRecord]) -> str:
    return "".join(r.model_dump_json() + "\n" for r in records)
