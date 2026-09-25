# ADR-0015: Phase 2: line items in Postgres, edit-before-approve re-validates, filtered export

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Phase 2 turns the skeleton into something a reviewer can use daily: richer
extraction (subtotal, tax, due date, line items), storage for it, a filterable
list with totals, correction of extracted fields before approval, and export.
Each of these touches the safety rules from earlier ADRs: only a human may
leave HOLD or EXCEPTION, every change is audited, and money is integer minor
units (ADR-0013).

## Decision

- **Line items live in their own table**, `invoice_line_items`, keyed by
  (tenant, invoice, position), with RLS forced like every other table. Header
  fields (`due_date`, `subtotal_minor`, `tax_minor`) are columns on `invoices`.
  Quantities are `numeric(16,4)`; money stays integer minor units as strings.
- **A correction is a new validation, not an edit in place.** `PATCH
  /v1/invoices/{id}` is allowed in PENDING_APPROVAL, HOLD and EXCEPTION, needs
  `expectedVersion`, and is idempotent. In one transaction it writes the
  fields, an `invoice.corrected` audit entry with every field's before and
  after, and routes the invoice through HOLD back to VALIDATING as the human.
  Deterministic validation (including a new totals check) then decides the next
  state. AI signals are not re-run, so a correction can never make the AI's
  view of an invoice look cleaner than it was.
- **Totals are checked deterministically.** Subtotal + tax must equal total,
  and when every line has an amount, lines + tax must equal total; otherwise
  the invoice goes to EXCEPTION with `VALIDATION_TOTALS_MISMATCH`.
- **List, summary and export share one filter** (state, text search, currency,
  invoice date range, total range), parsed once and turned into SQL once, so an
  export contains exactly what the dashboard shows. Search escapes LIKE
  wildcards. Export is capped at 10,000 rows and says so in
  `X-Export-Truncated`.
- **CSV is spreadsheet-safe:** UTF-8 BOM, CRLF, RFC 4180 quoting, and a leading
  quote on any cell starting with `=`, `+`, `-`, `@`, tab or CR.

## Consequences

- Corrected invoices carry `corrections` (the fields a human changed), shown as
  an "edited" badge and exported, so reviewers can see what was not the
  extractor's output.
- A correction that leaves the numbers inconsistent lands in EXCEPTION rather
  than being rejected, so the reviewer keeps their work and sees why.
- The same person can still correct and then approve. A four-eyes rule for
  money-field corrections is left for the approvals workflow in Phase 3.
- Images without a text layer still extract nothing (no OCR yet), and minor
  units assume two decimals for every currency.

## Alternatives considered

- **Line items as JSONB on `invoices`.** Simpler writes, but no per-row
  constraints and harder to query or export; rejected.
- **Correct in place without re-validating.** Would let a human edit move an
  invoice from EXCEPTION straight to approvable without the checks; rejected.
- **Asynchronous export jobs.** Unnecessary at 10,000 rows on free tiers; can
  be added behind the same filter later.
