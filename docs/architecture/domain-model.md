# Domain model

Source of truth: `services/core-api/src/domain/`. The tables below are checked
against the code by `tests/guardrails/docs-drift.test.ts`; if you change a
state or reason code, update this file in the same PR.

## Invoice lifecycle (14 states)

| State | Meaning | Allowed next states |
| --- | --- | --- |
| RECEIVED | Document registered, nothing parsed yet | EXTRACTING, HOLD, REJECTED |
| EXTRACTING | ai-service is extracting fields | EXTRACTED, EXCEPTION, HOLD |
| EXTRACTED | Fields available with confidences | VALIDATING, HOLD |
| VALIDATING | Header, totals, currency and vendor checks | VALIDATED, EXCEPTION, HOLD, REJECTED |
| VALIDATED | Passed validation | MATCHING, HOLD |
| MATCHING | Two- or three-way match against PO and receipts | MATCHED, EXCEPTION, HOLD, REJECTED |
| MATCHED | Matched within tolerance | PENDING_APPROVAL, HOLD |
| PENDING_APPROVAL | Waiting for an approver at the right tier | APPROVED, REJECTED, HOLD |
| APPROVED | Approved by a human | PAYMENT_QUEUED, HOLD |
| REJECTED | Terminal: will not be paid | (terminal) |
| HOLD | Stopped for review; only a human can release | VALIDATING, PENDING_APPROVAL, EXCEPTION, REJECTED |
| EXCEPTION | Needs data correction by a human | VALIDATING, HOLD, REJECTED |
| PAYMENT_QUEUED | Handed to the payment run | PAID, HOLD |
| PAID | Terminal: money moved | (terminal) |

Gate rules (`evaluateTransition`):

1. Terminal states are final.
2. An `ai` actor can only move an invoice into HOLD.
3. AI reason codes can only justify HOLD, whoever submits them.
4. APPROVED, REJECTED, and anything leaving HOLD or EXCEPTION need a `human`.
5. Entering HOLD, EXCEPTION or REJECTED needs at least one reason, and every
   reason must allow that outcome.

## Reason catalog (18 codes)

| Code | Source | Allowed outcomes |
| --- | --- | --- |
| MATCH_PRICE_VARIANCE | deterministic | HOLD, EXCEPTION |
| MATCH_QUANTITY_VARIANCE | deterministic | HOLD, EXCEPTION |
| MATCH_PO_NOT_FOUND | deterministic | EXCEPTION, REJECTED |
| MATCH_RECEIPT_MISSING | deterministic | HOLD, EXCEPTION |
| DUPLICATE_EXACT | deterministic | HOLD, REJECTED |
| DUPLICATE_NEAR | deterministic | HOLD |
| VENDOR_BANK_CHANGE_QUARANTINE | deterministic | HOLD |
| VENDOR_UNKNOWN | deterministic | EXCEPTION, REJECTED |
| VENDOR_INACTIVE | deterministic | HOLD, REJECTED |
| VALIDATION_MISSING_FIELD | deterministic | EXCEPTION |
| VALIDATION_TOTALS_MISMATCH | deterministic | EXCEPTION, REJECTED |
| VALIDATION_CURRENCY_UNSUPPORTED | deterministic | EXCEPTION, REJECTED |
| APPROVAL_LIMIT_EXCEEDED | deterministic | HOLD |
| POLICY_MANUAL_REVIEW_REQUIRED | deterministic | HOLD |
| AI_EXTRACTION_LOW_CONFIDENCE | ai | HOLD |
| AI_ANOMALY_SUSPECTED | ai | HOLD |
| AI_DOCUMENT_TAMPERING_SUSPECTED | ai | HOLD |
| AI_SEMANTIC_DUPLICATE_SUSPECTED | ai | HOLD |

## Policy

`PolicySchema` (Zod) validates each tenant's policy. Floors that cannot be
configured away: bank-change quarantine of at least 24 hours with mandatory
callback verification, price and quantity tolerance of at most 10%, and an AI
extraction-confidence hold threshold of at least 0.5. Approval tiers must be
strictly ascending.

## Money

Integer minor units as `bigint`, decimal strings on the wire (ADR-0013). The
minor unit is the currency's own ISO 4217 unit: cents for USD, yen for JPY,
fils for BHD (ADR-0018).
