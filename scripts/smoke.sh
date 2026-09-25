#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up, or a deploy).
# Uploads the sample invoice, waits for the pipeline, checks its line items,
# corrects a field, finds it with a filter and in the CSV export, approves it
# and verifies the audit chain. Needs curl and jq. Usage: scripts/smoke.sh [base-url]
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

say "checking the extracted line items"
LINES="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${ID}" | jq '.lineItems | length')"
[[ "$LINES" == 2 ]] || fail "expected 2 line items, got ${LINES}"

say "correcting a field before approval"
VERSION="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${ID}" | jq -r .version)"
CORRECTED="$(curl -fsS "${AUTH[@]}" -X PATCH -H 'content-type: application/json' -H "idempotency-key: smoke-correct-${ID}" \
  -d "{\"expectedVersion\":${VERSION},\"invoiceNumber\":\"SMOKE-${ID:0:8}\",\"comment\":\"smoke test\"}" "${BASE}/v1/invoices/${ID}")"
[[ "$(jq -r .state <<<"$CORRECTED")" == PENDING_APPROVAL ]] || fail "correction left the invoice in $(jq -r .state <<<"$CORRECTED")"
[[ "$(jq -r '.corrections | join(",")' <<<"$CORRECTED")" == invoiceNumber ]] || fail "correction was not recorded"

say "finding it with a dashboard filter and exporting it"
FOUND="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices?q=SMOKE-${ID:0:8}" | jq -r '.items[0].id')"
[[ "$FOUND" == "$ID" ]] || fail "search did not find the corrected invoice"
curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/export?q=SMOKE-${ID:0:8}" | grep -q "SMOKE-${ID:0:8}" || fail "CSV export is missing the invoice"
curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/summary" | jq -c '{count, byCurrency}'

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
