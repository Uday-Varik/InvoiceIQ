# ADR-0011: Pin TypeScript to 5.x

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

TypeScript 7 (the native Go port) is released. At the time of writing
`typescript-eslint` declares `typescript: >=4.8.4 <6.1.0` as its peer range,
and `openapi-typescript` relies on the compiler API that TypeScript 7 does not
expose in the same form.

## Decision

- Pin `typescript` to an exact 5.x version (currently `5.9.3`) at the root.
- Dependabot ignores TypeScript major updates; minor and patch updates flow
  normally.
- Revisit when both `typescript-eslint` and `openapi-typescript` declare
  support for 7.x.

## Consequences

- Lint and contract generation keep working.
- We forgo TypeScript 7 compile speed for now; the codebase is small enough
  that this costs seconds.
