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

## API steps (Phase 3)

- Record a change (AP clerk or above):
  `POST /v1/vendors/{vendorId}/bank-changes` with `ibanOrAccountLast4` and
  `evidenceDocumentSha256`. Returns 202; the vendor is quarantined at once.
- Look up the state: `GET /v1/vendors/{vendorId}` shows `bankChanges`,
  `paymentStatus` and, when blocked, `why` and `releasesAt`.
- Verify (AP manager or above, not the requester, latest change only):
  `POST /v1/vendors/{vendorId}/bank-changes/{changeId}/verify` with a
  `callbackNote` naming the number called and who confirmed.
- Invoices already on HOLD are not released automatically once the window
  closes: a reviewer resumes them from HOLD, and payment runs re-check the
  vendor at assembly and again at confirm.
- The web app has the same steps under **Vendors**; switch persona in the
  header bar to act as a different person in demo mode.
