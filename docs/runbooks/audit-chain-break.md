# Runbook: audit chain verification failed

**Signal:** `GET /v1/audit/verify` returns `ok: false` with `brokenAt`.

1. Treat as a security incident until proven otherwise. Freeze payment runs for
   the tenant (move queued invoices to HOLD with `POLICY_MANUAL_REVIEW_REQUIRED`).
2. Record `brokenAt` and `reason`. Export the chain from `brokenAt - 5` onward.
3. Compare against the latest external anchor (ADR-0009). If the anchor hash
   still matches an entry before `brokenAt`, the tampering is after it.
4. Check database audit logs for `UPDATE`/`DELETE` attempts on `audit_ledger`
   and for any role with owner or superuser rights that connected.
5. Do not "repair" the chain. Append a new entry describing the incident; the
   break stays as evidence.
6. Unfreeze only after security sign-off.
