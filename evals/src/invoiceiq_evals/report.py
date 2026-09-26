"""Compute and format evaluation metrics from run results."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import asdict, dataclass

from invoiceiq_data.taxonomy import Category, load_taxonomy
from invoiceiq_evals.runner import EvalResult


@dataclass(frozen=True, slots=True)
class CategoryMetrics:
    category_id: str
    title: str
    total: int
    detection_hits: int
    detection_rate: float
    outcome_hits: int
    outcome_accuracy: float


@dataclass(frozen=True, slots=True)
class Report:
    total_documents: int
    attack_documents: int
    clean_documents: int
    detection_rate: float
    outcome_accuracy: float
    false_hold_rate: float
    categories: list[CategoryMetrics]


def _variant_to_category(categories: list[Category]) -> dict[str, Category]:
    mapping: dict[str, Category] = {}
    for cat in categories:
        for v in cat.variants:
            mapping[v.id] = cat
    return mapping


def _is_ai_relevant(result: EvalResult) -> bool:
    """An attack doc is AI-relevant if at least one expected code is an AI code."""
    return bool(result.expected_ai_codes)


def compute(results: list[EvalResult]) -> Report:
    taxonomy = load_taxonomy()
    variant_to_cat = _variant_to_category(list(taxonomy.categories))

    clean = [r for r in results if not r.label.is_attack]
    attacks = [r for r in results if r.label.is_attack]

    false_holds = sum(1 for r in clean if r.fired_ai_codes)
    false_hold_rate = false_holds / len(clean) if clean else 0.0

    ai_attacks = [r for r in attacks if _is_ai_relevant(r)]
    detection_hits = sum(1 for r in ai_attacks if r.expected_ai_codes <= r.fired_ai_codes)
    detection_rate = detection_hits / len(ai_attacks) if ai_attacks else 0.0

    all_with_ai = ai_attacks + clean
    outcome_hits = 0
    for r in all_with_ai:
        if r.label.is_attack:
            if r.fired_ai_codes:
                outcome_hits += 1
        else:
            if not r.fired_ai_codes:
                outcome_hits += 1
    outcome_accuracy = outcome_hits / len(all_with_ai) if all_with_ai else 0.0

    cat_buckets: dict[str, list[EvalResult]] = defaultdict(list)
    for r in ai_attacks:
        cat = variant_to_cat.get(r.label.variant_id or "")
        if cat:
            cat_buckets[cat.id].append(r)

    categories: list[CategoryMetrics] = []
    for cat in taxonomy.categories:
        bucket = cat_buckets.get(cat.id, [])
        if not bucket:
            continue
        hits = sum(1 for r in bucket if r.expected_ai_codes <= r.fired_ai_codes)
        o_hits = sum(1 for r in bucket if r.fired_ai_codes)
        categories.append(
            CategoryMetrics(
                category_id=cat.id,
                title=cat.title,
                total=len(bucket),
                detection_hits=hits,
                detection_rate=hits / len(bucket) if bucket else 0.0,
                outcome_hits=o_hits,
                outcome_accuracy=o_hits / len(bucket) if bucket else 0.0,
            )
        )

    return Report(
        total_documents=len(results),
        attack_documents=len(attacks),
        clean_documents=len(clean),
        detection_rate=detection_rate,
        outcome_accuracy=outcome_accuracy,
        false_hold_rate=false_hold_rate,
        categories=categories,
    )


def to_json(report: Report) -> str:
    return json.dumps(asdict(report), indent=2) + "\n"


def to_text(report: Report) -> str:
    lines = [
        "Evaluation Report",
        "=================",
        f"Documents: {report.total_documents}"
        f" ({report.attack_documents} attacks, {report.clean_documents} clean)",
        f"AI detection rate: {report.detection_rate:.1%}",
        f"Outcome accuracy:  {report.outcome_accuracy:.1%}",
        f"False-hold rate:   {report.false_hold_rate:.1%}",
        "",
        "Per category (AI-relevant attacks only):",
    ]
    for c in report.categories:
        lines.append(
            f"  {c.title}: {c.detection_rate:.0%} detection ({c.detection_hits}/{c.total}), "
            f"{c.outcome_accuracy:.0%} outcome ({c.outcome_hits}/{c.total})"
        )
    return "\n".join(lines) + "\n"
