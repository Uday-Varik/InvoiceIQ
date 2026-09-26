"""CLI entry point: ``invoiceiq-evals [--json] [--threshold 0.8]``."""

from __future__ import annotations

import argparse
import sys

from invoiceiq_data.labels import SplitRecord
from invoiceiq_data.paths import DATA_DIR
from invoiceiq_evals.report import compute, to_json, to_text
from invoiceiq_evals.runner import DEFAULT_HOLD_THRESHOLD, evaluate_all


def _load_frozen(version: str = "test-v1") -> list[SplitRecord]:
    path = DATA_DIR / "frozen" / version / "test.jsonl"
    records: list[SplitRecord] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(SplitRecord.model_validate_json(line))
    return records


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate extraction and signals against the frozen test set",
    )
    parser.add_argument("--json", action="store_true", help="Output JSON instead of text")
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_HOLD_THRESHOLD,
        help=f"Extraction confidence hold threshold (default: {DEFAULT_HOLD_THRESHOLD})",
    )
    parser.add_argument("--version", default="test-v1", help="Frozen set version (default: test-v1)")
    args = parser.parse_args(argv)

    labels = _load_frozen(args.version)
    results = evaluate_all(labels, hold_threshold=args.threshold)
    report = compute(results)

    if args.json:
        sys.stdout.write(to_json(report))
    else:
        sys.stdout.write(to_text(report))


if __name__ == "__main__":
    main()
