# ADR-0013: Money as integer minor units

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Floating-point arithmetic cannot represent most decimal amounts exactly.
Tolerance checks (price variance in basis points) compound the error, and a
one-cent disagreement between services is enough to fail a three-way match.

## Decision

- In TypeScript, money is `{ amountMinor: bigint, currency: string }`.
- On the wire, `amountMinor` is a decimal **string** matching
  `^-?[0-9]{1,19}$`. The contract rejects JSON numbers for amounts.
- In Postgres, `bigint` minor units plus a `char(3)` currency.
- Quantities are integer thousandths. Tolerances are integer basis points and
  are compared with exact integer arithmetic (`withinBasisPoints`).
- Mixing currencies throws. There is no implicit FX.

## Consequences

- No rounding drift; `sum` of a thousand 10-cent items is exactly 1000 cents
  (tested).
- Currencies with three minor digits (for example KWD) need an exponent table
  before they can be enabled. Tracked for Phase 2.

## Alternatives considered

- **Decimal library.** Workable but slower and one more dependency on both
  sides; integers are sufficient.
- **Floats with rounding.** Rejected.
