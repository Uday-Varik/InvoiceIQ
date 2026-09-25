#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up, or a deploy).
# Uploads the sample invoice, waits for the pipeline, approves it and verifies
# the audit chain. Needs curl and jq. Usage: scripts/smoke.sh [base-url]
set -euo pipefail

BASE="${1:-http://localhost:3001}"
PDF="$(dirname "$0")/../apps/web/public/sample-invoice.pdf"
AUTH=()
if [[ -n "${SMOKE_TOKEN:-}" ]]; then AUTH=(-H "authorization: Bearer ${SMOKE_TOKEN}"); fi

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'SMOKE FAILED: %s\n' "$*" >&2; exit 1; }

say "waiting for core-api at ${BASE} (cold starts can take a minute)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 10 "${BASE}/healthz" >/dev/null 2>&1; then break; fi
  [[ $i -eq 60 ]] && fail "core-api never became healthy"
  sleep 3
done

# A unique trailer gives unique bytes, so reruns never hit the duplicate-document check.
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
cat "$PDF" > "$TMP"; printf '\n%% smoke %s\n' "$(date +%s%N)" >> "$TMP"

say "uploading the sample invoice"
INVOICE="$(curl -fsS "${AUTH[@]}" -H "idempotency-key: smoke-$(date +%s%N)" \
  -F "file=@${TMP};filename=sample-invoice.pdf;type=application/pdf" "${BASE}/v1/invoices")"
ID="$(jq -r .id <<<"$INVOICE")"
echo "invoice ${ID} is $(jq -r .state <<<"$INVOICE")"

say "waiting for extraction and validation"
STATE=""
for i in $(seq 1 60); do
  STATE="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${ID}" | jq -r .state)"
  case "$STATE" in
    PENDING_APPROVAL) break ;;
    HOLD|EXCEPTION|REJECTED) fail "pipeline stopped in ${STATE}: $(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${ID}" | jq -c .reasons)" ;;
  esac
  sleep 2
done
[[ "$STATE" == PENDING_APPROVAL ]] || fail "still ${STATE} after two minutes"
curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${ID}" | jq '{state, vendorName, invoiceNumber, invoiceDate, total}'

say "approving"
APPROVED="$(curl -fsS "${AUTH[@]}" -H 'content-type: application/json' -H "idempotency-key: smoke-approve-${ID}" \
  -d '{"comment":"smoke test"}' "${BASE}/v1/invoices/${ID}/approve" | jq -r .state)"
[[ "$APPROVED" == APPROVED ]] || fail "approve returned ${APPROVED}"
echo "invoice ${ID} is APPROVED"

say "verifying the audit chain"
VERIFY="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/audit/verify")"
echo "$VERIFY"
[[ "$(jq -r .ok <<<"$VERIFY")" == true ]] || fail "audit chain does not verify"

say "smoke passed"
