# Decision: State of Build

**Date:** 2026-10-06  
**Decision:** Unblock merge with current line-ending workaround; commit to systemic fix in next cycle.

## What Was Discovered

The build had **two failing tests**, not one:

1. `services/core-api/test/catalog-export.test.ts` — catalog JSON has CRLF on Windows, generated output has LF
2. `tests/guardrails/docs-drift.test.ts` — ADR titles contain `\r` after line splits, fail to match README

Both stem from `git autocrlf=true` on Windows converting line endings on checkout. The pragmatist's initial assessment only caught the first; the skeptic discovered the second and traced the common root.

## What Was Decided

**Unblock the merge now:**
- The skeptic's fixes (line-ending detection in `export-catalog.ts` + test helper normalization) work and pass tests locally
- This allows the current PR to ship without being gate-kept by platform-specific issues
- **Gate:** Confirm both tests pass in CI before merge

**Systemic fix deferred to next PR:**
- Add `.gitattributes` to enforce LF across `*.ts`, `*.json`, `*.md` (removes platform-awareness from export script)
- Add pre-commit hook or CI check to validate line endings
- Run tests on both Linux and Windows in CI to catch platform drift early

## Why This Trade-Off

**Why ship the workaround now:**
- It works and is tested
- It unblocks the team (don't gate a merge on infrastructure change)
- The risk is contained (only affects Windows devs during generation; CI will see consistent LF)

**Why the systemic fix is urgent but not blocking:**
- The current approach (per-script detection + test normalization) is fragile and doesn't scale
- `.gitattributes` is the proper solution and prevents future surprises
- It's engineering work, not an emergency fix; it belongs in its own PR with design review

## What's Still Open

1. **Verify CI passes.** The fixes are tested locally; confirm they hold in the CI environment (which may have different git/OS config).
2. **Schedule the `.gitattributes` PR.** This should be first in the next cycle—it's foundational and will make future line-ending issues disappear.
3. **Document the workaround.** Leave a comment in `export-catalog.ts` explaining the detection logic and that it's temporary—point to the `.gitattributes` PR as the replacement.

## Options That Lost

- **"Just ignore the test failure and merge anyway"** — No. The tests are catching real problems.
- **"Do the full `.gitattributes` fix now"** — No. That's a separate system change and can follow. Don't block ship.
- **"Regenerate the catalog manually and call it fixed"** — Incomplete. That would mask the second failing test and leave the platform inconsistency unsolved.

## Verdict

Build is unblocked. Ship with current fixes, then solidify with `.gitattributes` in the next iteration.
