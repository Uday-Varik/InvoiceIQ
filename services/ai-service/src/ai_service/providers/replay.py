"""Record/replay providers. Recordings are JSON files named by request key."""

from __future__ import annotations

import json
from pathlib import Path

from ai_service.providers.base import Completion, LLMProvider, ProviderError, request_key


class ReplayMissError(ProviderError):
    """No recording exists for this request."""


class ReplayProvider:
    name = "replay"

    def __init__(self, directory: Path) -> None:
        self._dir = directory

    def complete(self, *, task: str, prompt: str) -> Completion:
        key = request_key(task=task, prompt=prompt)
        path = self._dir / f"{key}.json"
        if not path.is_file():
            raise ReplayMissError(f"no recording for {task} ({key[:12]})")
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("key") != key:
            raise ProviderError(f"recording {path.name} has a mismatched key")
        return Completion(provider=str(data["provider"]), model=str(data["model"]), text=str(data["text"]))


class RecordingProvider:
    """Wraps a live provider and writes every completion to disk for later replay."""

    name = "recording"

    def __init__(self, inner: LLMProvider, directory: Path) -> None:
        self._inner = inner
        self._dir = directory

    def complete(self, *, task: str, prompt: str) -> Completion:
        completion = self._inner.complete(task=task, prompt=prompt)
        key = request_key(task=task, prompt=prompt)
        self._dir.mkdir(parents=True, exist_ok=True)
        record = {
            "key": key,
            "task": task,
            "provider": completion.provider,
            "model": completion.model,
            "text": completion.text,
        }
        (self._dir / f"{key}.json").write_text(
            json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        return completion
