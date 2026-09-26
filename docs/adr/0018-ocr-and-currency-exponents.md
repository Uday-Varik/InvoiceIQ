# ADR-0018: OCR with Tesseract for scans, and ISO 4217 exponents for every amount

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Two gaps were left open after Phase 4. Scanned invoices (photos, PNG or JPEG
uploads, and PDFs with no text layer) produced no text, so every field came
back unknown and a person typed the whole invoice. Every amount also assumed two
decimals: a yen invoice for ¥35,200 would have been stored as 3,520,000 minor
units if it was read at all, and exports and forms showed "352.00". ADR-0013
already stores money as integer minor units; the minor unit just has to be the
currency's own.

## Decision

- **One exponent table, owned by core-api.** `CURRENCY_EXPONENTS` in
  `services/core-api/src/domain/currency.ts` lists the ISO 4217 currencies
  whose minor unit is not two decimals (0 for JPY, KRW and others; 3 for BHD,
  KWD and others; 4 for CLF and UYW). It is exported to the contracts catalog.
  The web app reads the catalog; ai-service carries a copy that a test keeps
  identical. Stored values do not change: `amountMinor` was always an integer,
  and for yen it now means yen.
- **Formatting and parsing follow the currency.** CSV exports, payment files,
  the web display, the correction form and the dashboard's amount filters all
  use the exponent. Typing "1100.50" for a yen invoice is refused rather than
  rounded.
- **The extractor finds the currency first.** The heuristic provider reads the
  currency, then builds its amount patterns for that exponent: whole numbers for
  yen, three decimals for dinars. Because any integer can look like a yen
  amount, a yen line item needs a currency marker or quantities that multiply
  out. `¥` counts as a weaker guess than `₩`, since it is also the yuan.
- **OCR runs Tesseract and Poppler as subprocesses.** Images go straight to
  `tesseract`. PDFs with fewer than 16 characters of text are rasterised by
  `pdftoppm` (first 3 pages, 200 dpi, longest side capped) and then OCRed.
  The pixel count is read from the PNG or JPEG header and anything over
  40 megapixels is refused before any decoder runs. Each call has a 30 s
  timeout, runs single-threaded, uses no shell, and gets an environment with
  only `PATH`, `OMP_THREAD_LIMIT` and `LC_ALL`, so no secret reaches it.
- **OCR confidence is capped at 0.85.** OCR misreads digits, so a field read
  from a scan never scores as high as a labelled text-layer field. The cap is
  above the default hold threshold (0.8), so a clean scan can still reach
  approval, and the arithmetic cross-check still catches misread totals. The
  provider is reported as `heuristic+ocr` and counted in
  `invoiceiq_ai_document_text_total{source}`.
- **Missing tools degrade to today's behaviour.** Without the binaries a scan
  yields no text, every field is unknown, and the invoice waits for a person.
  The ai-service image installs them from Debian's archive; CI installs them
  and sets `REQUIRE_OCR=1` so the OCR tests cannot silently skip.

## Consequences

- The ai-service image grows by tens of megabytes for Tesseract, its English
  data and Poppler.
- OCR adds seconds per scanned page, which is well within the outbox's retry
  budget.
- A tenant must still enable a currency in its policy; the demo tenant now
  enables JPY and BHD. Invoices in a currency other than the base currency
  still need the top approval tier (ADR-0016).
- Corrupt images are now refused as unreadable, which core-api already holds
  for manual review, instead of being treated as blank.

## Alternatives considered

- **pytesseract or a Python imaging stack.** Wraps the same binary and adds
  Pillow, which decodes images in-process; calling the CLI keeps decoding in a
  separate process with a timeout.
- **A cloud OCR API.** Better on poor scans, but it sends invoices to a third
  party and needs an account and a key; it can be added behind the same
  interface when live model calls arrive.
- **A per-currency decimals column in Postgres.** Redundant with ISO 4217 and a
  second source of truth; the exponent is a property of the currency code.
- **Rounding over-precise input.** Silently changing a typed amount on a money
  form is worse than asking again.
