# Skeptic's View: State of Build

Tests pass locally, but we're trusting platform-specific behavior. Here's what could still break:

## Risks in the line-ending fixes

1. **CI/CD may use different autocrlf settings** — Our fixes assume Windows dev machines have `core.autocrlf=true`. What if CI runs on Linux with `autocrlf=false`? The catalog file would be checked in with LF, then the fix tries to detect CRLF that won't exist, and nothing breaks—but we're not actually testing cross-platform consistency.

2. **The "detect and match" approach is fragile** — `export-catalog.ts` now reads the existing file to decide what line endings to use. If that file doesn't exist (fresh clone), it defaults to LF. If the file exists with mixed or inconsistent line endings, it might do the wrong thing. We're guessing intent from the first occurrence of `\r\n`.

3. **Test helper normalization hides the real problem** — Normalizing all reads to LF in the test helper masks the fact that our docs files might actually have CRLF. We're not testing against the real line endings; we're erasing them and hoping nothing cares.

## Questions

- Are docs/adr files committed with consistent line endings? Do we enforce that?
- Does `packages/contracts/catalog/reason-codes.json` get regenerated in CI, or is it just checked?
- If a contributor on macOS commits with LF and a Windows dev regenerates it with CRLF, will git see that as a change to all lines?

## What should happen next

- Add a `.gitattributes` rule to enforce consistent line endings: `* text=auto` with explicit overrides for binary files, or pin everything to LF (`*.ts text eol=lf`, `*.json text eol=lf`).
- Add a pre-commit hook or CI check that fails if line endings are inconsistent.
- Run tests in CI on both Linux and Windows to catch platform-specific issues before they ship.

Current build passes, but we've papered over a systemic issue. The fixes work, but we're one careless commit away from the same problem.
