"""Filesystem layout of data/. Everything is relative to the data/ directory."""

from __future__ import annotations

from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = DATA_DIR.parent
CATALOG = REPO_ROOT / "packages" / "contracts" / "catalog" / "reason-codes.json"
TAXONOMY = DATA_DIR / "redteam" / "taxonomy.yaml"
LABEL_SCHEMA = DATA_DIR / "schemas" / "label.schema.json"
SYNTHETIC = DATA_DIR / "synthetic" / "labels.jsonl"
SPLITS_DIR = DATA_DIR / "splits"
FROZEN_TEST_DIR = DATA_DIR / "frozen" / "test-v1"
