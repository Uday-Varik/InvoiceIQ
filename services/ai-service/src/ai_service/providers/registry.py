"""Provider registry: maps names to factory functions.

Provider selection is driven by the ``EXTRACTION_PROVIDER`` env var (default:
``heuristic``).  A provider that requires an API key (e.g. a future Claude or
OpenAI provider) must raise ``ProviderError`` at construction time when the
key is absent, so the service refuses to start rather than failing on the
first request.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

from ai_service.providers.base import ExtractionProvider, ProviderError
from ai_service.providers.echo import EchoProvider
from ai_service.providers.heuristic import HeuristicProvider
from ai_service.providers.replay import ReplayProvider

ProviderFactory = Callable[[], ExtractionProvider]

_REGISTRY: dict[str, ProviderFactory] = {}


def register(name: str, factory: ProviderFactory) -> None:
    _REGISTRY[name] = factory


def registered_names() -> frozenset[str]:
    return frozenset(_REGISTRY)


def _heuristic() -> ExtractionProvider:
    return HeuristicProvider()


def _echo() -> ExtractionProvider:
    return EchoProvider()


def _replay() -> ExtractionProvider:
    replay_dir = os.environ.get("AI_REPLAY_DIR", "")
    if not replay_dir:
        raise ProviderError("EXTRACTION_PROVIDER=replay requires AI_REPLAY_DIR to be set")
    return ReplayProvider(Path(replay_dir))


register("heuristic", _heuristic)
register("echo", _echo)
register("replay", _replay)


def resolve(name: str | None = None) -> ExtractionProvider:
    """Return the provider for *name*, defaulting to ``EXTRACTION_PROVIDER`` env var or ``heuristic``."""
    chosen = name or os.environ.get("EXTRACTION_PROVIDER", "heuristic")
    factory = _REGISTRY.get(chosen)
    if factory is None:
        available = ", ".join(sorted(_REGISTRY))
        raise ProviderError(f"unknown provider {chosen!r} (available: {available})")
    return factory()
