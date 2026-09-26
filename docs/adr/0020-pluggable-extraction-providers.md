# ADR-0020: Pluggable extraction providers

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

The AI service's extraction pipeline has always accepted any object that
satisfies the `LLMProvider` protocol (ADR-0006), but in practice the only
implementations were `HeuristicProvider` (regex-based, offline) and the
record/replay pair. The `LLMProvider` name was misleading — the heuristic
provider is not an LLM — and there was no config-driven way to swap providers
without code changes. The evals harness (ADR-0019) hardcoded
`HeuristicProvider` by type, so adding a new provider meant editing every call
site.

Before a real ML-backed provider can be added (Claude, OpenAI, or a
self-hosted model), the extraction layer needs a clean seam: a provider
interface with a canonical name, config-based selection, a stub provider for
integration tests, and the eval harness wired to score any provider against
the frozen test set.

## Decision

### Rename the protocol

`LLMProvider` is renamed to `ExtractionProvider`. `LLMProvider` remains as a
backward-compatible alias so downstream code and tests that import it keep
working.

### Provider registry

A new `providers.registry` module maps provider names to factory functions.
Three providers are registered at import time:

| Name | Provider | Notes |
|------|----------|-------|
| `heuristic` | `HeuristicProvider` | Default; regex-based, fully offline |
| `echo` | `EchoProvider` | Returns a fixed payload; for integration tests |
| `replay` | `ReplayProvider` | Requires `AI_REPLAY_DIR` |

`resolve(name)` returns the provider instance. When `name` is `None`, it reads
the `EXTRACTION_PROVIDER` environment variable (default: `heuristic`).
Third-party or future providers call `register(name, factory)` to add
themselves; a provider whose factory requires an API key raises `ProviderError`
at construction time so the service refuses to start.

### Echo provider

`EchoProvider` accepts an optional payload dict and returns it as JSON for
every request, regardless of input. It satisfies the `ExtractionProvider`
protocol and is useful in integration tests that need a provider which always
succeeds without parsing real text.

### Provider selection in the API

`default_provider()` in `api/app.py` now delegates to `resolve()`. The
existing `AI_REPLAY_DIR` env var is still honoured: when set, the replay
provider is selected; otherwise `EXTRACTION_PROVIDER` (or its default) is
used. The `create_app(provider=...)` parameter still works for test injection.

### Eval harness generalised

`evaluate_one()` and `evaluate_all()` now accept any `ExtractionProvider`
(defaulting to `HeuristicProvider`). The CLI adds `--provider <name>` which
resolves through the registry. The evaluation report includes the provider
name so results are comparable across providers.

## Consequences

- Adding a new provider is one file plus one `register()` call. No call-site
  changes in extraction, signals, the API, or the eval harness.
- The heuristic baseline is published for the frozen test set; any new
  provider's eval output is directly comparable.
- A provider that needs an API key (e.g. Claude) stays unregistered until
  the key is available — no dead code, no stub API calls.
- The import-linter layer contract (`api → extraction|signals → documents →
  providers`) is preserved: the registry lives inside `providers`.
