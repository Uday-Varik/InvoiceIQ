"""Echo provider: returns a fixed JSON payload for every request.

Useful in integration tests that need a provider which always succeeds
without touching a network or parsing real text.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from ai_service.providers.base import Completion


class EchoProvider:
    name = "echo"
    model = "echo-v1"

    def __init__(self, payload: Mapping[str, Any] | None = None) -> None:
        self._text = json.dumps(dict(payload) if payload else {}, sort_keys=True)

    def complete(self, *, task: str, prompt: str) -> Completion:
        return Completion(provider=self.name, model=self.model, text=self._text)
