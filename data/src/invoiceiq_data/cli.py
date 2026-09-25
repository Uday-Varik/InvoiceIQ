"""invoiceiq-data: build and check synthetic data artifacts.

build   regenerate schema, labels and splits (never touches frozen sets)
freeze  copy the current test split into a new frozen directory + manifest
check   fail if any committed artifact drifted, a frozen set was tampered
        with, the taxonomy is invalid, or a family leaks across splits
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from invoiceiq_data.generator import generate, to_jsonl
from invoiceiq_data.labels import label_json_schema
from invoiceiq_data.manifest import verify_manifest, write_manifest
from invoiceiq_data.paths import DATA_DIR, FROZEN_TEST_DIR, LABEL_SCHEMA, SPLITS_DIR, SYNTHETIC
from invoiceiq_data.splits import family_leaks, split_records
from invoiceiq_data.taxonomy import load_taxonomy, validate_taxonomy


def render_all() -> dict[Path, str]:
    taxonomy = load_taxonomy()
    records = generate(taxonomy)
    splits = split_records(records)
    out: dict[Path, str] = {LABEL_SCHEMA: label_json_schema(), SYNTHETIC: to_jsonl(list(records))}
    for name, rows in splits.items():
        out[SPLITS_DIR / f"{name}.jsonl"] = "".join(r.model_dump_json() + "\n" for r in rows)
    return out


def cmd_build() -> int:
    for path, content in render_all().items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(f"wrote {path.relative_to(DATA_DIR)}")
    return 0


def cmd_freeze(target: Path) -> int:
    if target.exists():
        print(f"refusing to overwrite frozen set {target}; create a new version", file=sys.stderr)
        return 1
    target.mkdir(parents=True)
    (target / "test.jsonl").write_text(
        (SPLITS_DIR / "test.jsonl").read_text(encoding="utf-8"), encoding="utf-8"
    )
    manifest = write_manifest(target)
    print(f"froze {target.relative_to(DATA_DIR)} root={manifest['root']}")
    return 0


def cmd_check() -> int:
    problems = [f"taxonomy: {p}" for p in validate_taxonomy(load_taxonomy())]
    rendered = render_all()
    for path, content in rendered.items():
        if not path.is_file() or path.read_text(encoding="utf-8") != content:
            problems.append(f"drift: {path.relative_to(DATA_DIR)} is stale; run `make data`")
    leaks = family_leaks(split_records(generate(load_taxonomy())))
    if leaks:
        problems.append(f"family leak across splits: {leaks[:5]}")
    problems += [f"frozen {FROZEN_TEST_DIR.name}: {p}" for p in verify_manifest(FROZEN_TEST_DIR)]
    for p in problems:
        print(p, file=sys.stderr)
    if not problems:
        print("data: taxonomy valid, artifacts current, splits family-safe, frozen set intact")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="invoiceiq-data", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build")
    freeze = sub.add_parser("freeze")
    freeze.add_argument("--to", type=Path, default=FROZEN_TEST_DIR)
    sub.add_parser("check")
    args = parser.parse_args(argv)
    if args.command == "build":
        return cmd_build()
    if args.command == "freeze":
        return cmd_freeze(args.to)
    return cmd_check()


if __name__ == "__main__":
    raise SystemExit(main())
