"""Read-only view of the reason catalog exported by core-api."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from invoiceiq_data.paths import CATALOG


@dataclass(frozen=True, slots=True)
class Reason:
    code: str
    source: str
    allowed_outcomes: tuple[str, ...]


@cache
def load_catalog(path: Path = CATALOG) -> dict[str, Reason]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        code: Reason(code=code, source=r["source"], allowed_outcomes=tuple(r["allowedOutcomes"]))
        for code, r in raw["reasonCodes"].items()
    }
