"""Extraction provider abstraction (ADR-0006, ADR-0020).

Every extraction call goes through ``ExtractionProvider.complete``.  Requests
are keyed by a stable hash so a recording made once can be replayed
byte-for-byte in tests and CI without network access or API keys.

``LLMProvider`` is kept as a backward-compatible alias.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


class ProviderError(RuntimeError):
    """The provider could not produce a completion."""


@dataclass(frozen=True, slots=True)
class Completion:
    provider: str
    model: str
    text: str


@runtime_checkable
class ExtractionProvider(Protocol):
    name: str

    def complete(self, *, task: str, prompt: str) -> Completion: ...


LLMProvider = ExtractionProvider


def request_key(*, task: str, prompt: str) -> str:
    """Stable key for a request: sha256 over canonical JSON of the inputs."""
    body = json.dumps({"task": task, "prompt": prompt}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()
