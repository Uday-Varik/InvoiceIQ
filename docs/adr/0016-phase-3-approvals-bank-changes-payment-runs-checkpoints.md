# ADR-0016: Phase 3: tiered approvals, bank-change quarantine, payment runs, signed checkpoints

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Phase 3 moves invoices from "approved" to "paid". That step is where AP fraud
lands: the approver who uploaded the invoice, the vendor whose bank account was
swapped by email, the payment file nobody reconciled, and an audit log an
insider could rewrite end to end. ADR-0007 already says the AI can only put
invoices on HOLD; this ADR decides what the humans must do before money moves.

## Decision

- **Approval tiers with separation of duties.** The policy's tiers say which
  role may approve up to what amount and how many distinct people must approve.
  A person who uploaded the invoice (`created_by`) or corrected it (an
  `invoice.corrected` audit entry) cannot approve it. Approvals are stored per
  invoice version in `invoice_approvals`, so any correction or state change
  resets them. An invoice in a currency other than the tenant's base currency
  needs the top tier, because the tier limits are in base currency.
- **Bank changes are quarantined.** A change is recorded by an AP clerk or
  above with a hash of the evidence, never the full account number (last four
  only). A different person of AP manager or above verifies it by calling back
  on a number from the vendor master; a database CHECK refuses
  `verified_by = requested_by`. Payments to the vendor are blocked until the
  latest change is verified and the policy window has passed. The pipeline
  sends a blocked vendor's invoices to HOLD with `VENDOR_BANK_CHANGE_QUARANTINE`
  or `VENDOR_INACTIVE`.
- **Payments happen only in runs, and only humans pay.** An AP manager assembles
  a run of approved invoices in one currency (oldest due first, at most 500);
  blocked vendors' invoices go to HOLD instead. Each item snapshots the vendor,
  account last four and bank change id. A controller or above who did not
  create the run confirms it; confirm is refused if any item's vendor is now
  blocked or its bank details changed after assembly. Cancel needs a comment
  and returns invoices to HOLD for review. `PAYMENT_QUEUED` and `PAID` are no
  longer reachable through the generic transitions endpoint.
- **The payment file is generated from the snapshot**, as CSV with BOM, CRLF
  and the formula guard from ADR-0015, so what is paid is what was confirmed.
- **Audit checkpoints are signed and exportable.** `POST /v1/audit/checkpoints`
  verifies the chain, then signs `{v, tenantId, seq, hash, createdAt, keyId}`
  with Ed25519 (`AUDIT_CHECKPOINT_KEY`). Checkpoints are append-only in the
  database and meant to be copied somewhere the database admin cannot write
  (email, a ticket, object storage with retention). `/v1/audit/verify` checks
  every stored checkpoint against the chain, and
  `/v1/audit/checkpoints/verify` checks an external copy, so a rewrite that
  re-hashes the whole chain is detected.
- **Demo personas** (`Authorization: Demo <persona>` or a cookie) give the demo
  auth mode distinct people and roles, so separation of duties can be exercised
  without an identity provider.

## Consequences

- One person can no longer take an invoice from upload to paid. Small teams
  need at least two people with the right roles, and the top tier needs two
  CFO-level approvers.
- A legitimate bank change delays that vendor's payments by the policy window.
- If `AUDIT_CHECKPOINT_KEY` is unset, an ephemeral key is generated and old
  checkpoints cannot be verified after a restart; the service logs a warning.
- A run's payment file is only as trustworthy as the bank that receives it;
  sending it is still manual.

## Alternatives considered

- **Approval limits per user instead of per role.** More flexible, but needs an
  admin UI and a user directory; roles are enough until SSO lands.
- **Storing full account numbers.** Would let InvoiceIQ build bank files
  directly, but makes the database a target; last four plus evidence hash is
  enough to detect a change.
- **Anchoring checkpoints to a public ledger or RFC 3161 timestamp authority.**
  Stronger, but adds an external dependency on free tiers; a signed statement
  the tenant stores elsewhere gives most of the benefit and can be anchored
  later without changing the format.
