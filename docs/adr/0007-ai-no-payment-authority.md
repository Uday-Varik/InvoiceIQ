# ADR-0007: AI holds no payment authority

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

ai-service reads attacker-controlled documents. Prompt injection, adversarial
formatting and plain model error are expected, not exceptional. If a model
output can approve, release or pay, an attacker can too.

## Decision

AI is advisory and can only make the system **more** cautious (monotonic
safety):

1. **Reason catalog.** AI-derived reason codes (prefix `AI_`) have type
   `AiReason` with `allowedOutcomes: readonly ['HOLD']`. A catalog entry that
   lets an AI code reject, raise an exception or approve does not compile.
2. **Lifecycle gate.** `evaluateTransition` refuses any transition by an `ai`
   actor other than into `HOLD`, and refuses any non-HOLD transition that cites
   an AI reason, whoever submits it. Leaving `HOLD` needs a human.
3. **Contract.** `Signal.outcome` in the ai-service contract is
   `const: HOLD`; Zod and Pydantic both reject anything else.
4. **Credentials.** ai-service has no database credentials. import-linter
   forbids database drivers and ORMs in `ai_service`, and a test scans for SQL
   against money tables.
5. **Routes.** A test fails if ai-service exposes a route whose path mentions
   approve, reject, release, payment, transition or state.

## Consequences

- Worst case for a fully compromised model is more invoices on HOLD: an
  availability cost, never a payment.
- AI cannot clear a false positive; a human must. This is intentional.
- Each layer is tested independently, so removing one does not silently remove
  the guarantee.

## Alternatives considered

- **Confidence-gated auto-approval.** Rejected: turns model confidence into
  payment authority.
- **Policy flag to let AI release holds.** Rejected: a flag is one bad config
  away from the failure this ADR exists to prevent.
