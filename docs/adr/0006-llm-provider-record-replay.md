# ADR-0006: LLM provider abstraction with record/replay

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Model calls are slow, cost money, need API keys and are non-deterministic. CI
must be fast, free, offline and reproducible, and evaluation results must be
comparable across runs.

## Decision

- All model calls go through one protocol, `LLMProvider.complete(task, prompt)`
  in `ai_service.providers`.
- Requests are keyed by `sha256` of canonical JSON of `(task, prompt)`.
- `RecordingProvider` wraps a live provider and writes each completion to
  `<key>.json`. `ReplayProvider` serves those files and raises
  `ReplayMissError` on anything unrecorded.
- CI and unit tests run on replay or on the offline `HeuristicProvider` only.
  No test may need network access or an API key.
- Model output is untrusted: the extraction parser drops unknown keys, coerces
  bad confidences to 0.0 and cannot add fields.

## Consequences

- Tests are deterministic and run in milliseconds.
- Swapping vendors is a new class behind the protocol.
- Recordings go stale when prompts change; a replay miss is loud, never a
  silent fallback to a live call.

## Alternatives considered

- **Mock per test.** Rejected: mocks drift from real output and do not help
  evals.
- **VCR-style HTTP cassettes.** Rejected: tied to one vendor's wire format and
  records auth headers.
