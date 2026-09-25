# Runbook: payment held by bank-change quarantine

**Signal:** invoice on HOLD with `VENDOR_BANK_CHANGE_QUARANTINE`.

1. Look up the change: who entered it, when, and whether it was verified.
2. `why = UNVERIFIED`: a second person calls the vendor on a number from the
   vendor master (never from the change request or invoice) and records the
   verification.
3. `why = SELF_VERIFIED`: the verifier is the person who made the change. A
   different person must verify.
4. `why = WINDOW_OPEN`: verification is done; the hold lifts at `releasesAt`.
   Do not shorten the window; the policy schema will not allow less than 24h.
5. If the vendor denies requesting the change, revert the bank details, keep
   the invoice on HOLD and follow the fraud process.
