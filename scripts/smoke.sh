#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up, or a deploy).
# Uploads the sample invoice, waits for the pipeline, checks its line items,
# corrects a field, finds it with a filter and in the CSV export, approves it as
# a second person, pays it in a run confirmed by a third, signs an audit
# checkpoint and verifies the chain. Then it uploads a scanned yen invoice to
# check OCR and a currency without decimals. Needs curl and jq. Usage: scripts/smoke.sh [base-url]
#
# Separation of duties needs distinct people. In demo auth mode the script uses
# the demo personas; with SMOKE_TOKEN (uploader) also set SMOKE_MANAGER_TOKEN
# (ap_manager, approves and assembles) and SMOKE_CONTROLLER_TOKEN (confirms).
# SMOKE_METRICS_TOKEN, when set, also checks /metrics after the flow.
set -euo pipefail

BASE="${1:-http://localhost:3001}"
PDF="$(dirname "$0")/../apps/web/public/sample-invoice.pdf"
AUTH=()
MANAGER=(-H "authorization: Demo demo-manager")
CONTROLLER=(-H "authorization: Demo demo-controller")
if [[ -n "${SMOKE_TOKEN:-}" ]]; then
  AUTH=(-H "authorization: Bearer ${SMOKE_TOKEN}")
  MANAGER=(-H "authorization: Bearer ${SMOKE_MANAGER_TOKEN:?set SMOKE_MANAGER_TOKEN with SMOKE_TOKEN}")
  CONTROLLER=(-H "authorization: Bearer ${SMOKE_CONTROLLER_TOKEN:?set SMOKE_CONTROLLER_TOKEN with SMOKE_TOKEN}")
fi

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'SMOKE FAILED: %s\n' "$*" >&2; exit 1; }

say "waiting for core-api at ${BASE} (cold starts can take a minute)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 10 "${BASE}/healthz" >/dev/null 2>&1; then break; fi
  [[ $i -eq 60 ]] && fail "core-api never became healthy"
  sleep 3
done

say "checking readiness (database and migrations)"
READY="$(curl -fsS "${BASE}/readyz")" || fail "/readyz is not ready: $(curl -sS "${BASE}/readyz")"
jq -c '{status, migrations: .checks.migrations}' <<<"$READY"

# A unique trailer gives unique bytes, so reruns never hit the duplicate-document check.
SCAN_PNG="$(dirname "$0")/../services/ai-service/tests/fixtures/documents/scanned-invoice.png"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
cat "$PDF" > "$TMP"; printf '\n%% smoke %s\n' "$(date +%s%N)" >> "$TMP"

say "uploading the sample invoice (with a trace id to follow)"
TRACE_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
HEADERS="$(mktemp)"; trap 'rm -f "$TMP" "$HEADERS"' EXIT
INVOICE="$(curl -fsS -D "$HEADERS" "${AUTH[@]}" -H "idempotency-key: smoke-$(date +%s%N)" \
  -H "traceparent: 00-${TRACE_ID}-00f067aa0ba902b7-01" \
  -F "file=@${TMP};filename=sample-invoice.pdf;type=application/pdf" "${BASE}/v1/invoices")"
grep -qi "^x-trace-id: ${TRACE_ID}" "$HEADERS" || fail "core-api did not continue the caller's trace"
echo "trace ${TRACE_ID}"
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

say "approving as a second person (the uploader cannot approve)"
APPROVED="$(curl -fsS "${MANAGER[@]}" -H 'content-type: application/json' -H "idempotency-key: smoke-approve-${ID}" \
  -d '{"comment":"smoke test"}' "${BASE}/v1/invoices/${ID}/approve" | jq -r .state)"
[[ "$APPROVED" == APPROVED ]] || fail "approve returned ${APPROVED}"
echo "invoice ${ID} is APPROVED"

say "paying it in a run: assembled by the manager, confirmed by the controller"
CURRENCY="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${ID}" | jq -r .total.currency)"
RUN="$(curl -fsS "${MANAGER[@]}" -H 'content-type: application/json' -H "idempotency-key: smoke-run-${ID}" \
  -d "{\"currency\":\"${CURRENCY}\",\"invoiceIds\":[\"${ID}\"],\"comment\":\"smoke test\"}" "${BASE}/v1/payment-runs")"
RUN_ID="$(jq -r .run.id <<<"$RUN")"
[[ "$(jq -r .run.invoiceCount <<<"$RUN")" == 1 ]] || fail "payment run did not take the invoice: $(jq -c .held <<<"$RUN")"
curl -fsS "${MANAGER[@]}" "${BASE}/v1/payment-runs/${RUN_ID}/file" | grep -q "$ID" || fail "payment file is missing the invoice"
PAID="$(curl -fsS "${CONTROLLER[@]}" -H 'content-type: application/json' -H "idempotency-key: smoke-confirm-${RUN_ID}" \
  -d '{"expectedVersion":1}' "${BASE}/v1/payment-runs/${RUN_ID}/confirm" | jq -r .status)"
[[ "$PAID" == paid ]] || fail "confirm returned ${PAID}"
[[ "$(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${ID}" | jq -r .state)" == PAID ]] || fail "invoice is not PAID"
echo "run ${RUN_ID} is paid"

say "signing an audit checkpoint and verifying a copy of it"
CHECKPOINT="$(curl -fsS "${MANAGER[@]}" -X POST "${BASE}/v1/audit/checkpoints")"
jq -c '{seq, keyId}' <<<"$CHECKPOINT"
[[ "$(curl -fsS "${AUTH[@]}" -H 'content-type: application/json' -d "$CHECKPOINT" "${BASE}/v1/audit/checkpoints/verify" | jq -r .ok)" == true ]] \
  || fail "checkpoint does not verify"

say "verifying the audit chain"
VERIFY="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/audit/verify")"
echo "$VERIFY"
[[ "$(jq -r .ok <<<"$VERIFY")" == true ]] || fail "audit chain does not verify"

say "uploading a scanned yen invoice (OCR, no decimals)"
SCAN="$(mktemp)"; trap 'rm -f "$TMP" "$HEADERS" "$SCAN"' EXIT
# Bytes after the PNG's end are ignored by readers but make each run a new document.
cat "$SCAN_PNG" > "$SCAN"; printf 'smoke %s' "$(date +%s%N)" >> "$SCAN"
SCAN_ID="$(curl -fsS "${AUTH[@]}" -H "idempotency-key: smoke-scan-$(date +%s%N)" \
  -F "file=@${SCAN};filename=scanned-invoice.png;type=image/png" "${BASE}/v1/invoices" | jq -r .id)"
for i in $(seq 1 60); do
  SCANNED="$(curl -fsS "${AUTH[@]}" "${BASE}/v1/invoices/${SCAN_ID}")"
  case "$(jq -r .state <<<"$SCANNED")" in
    RECEIVED|EXTRACTING|EXTRACTED|VALIDATING|VALIDATED|MATCHING|MATCHED) sleep 2 ;;
    *) break ;;
  esac
done
jq -c '{state, vendorName, total, provider: .extraction.provider}' <<<"$SCANNED"
[[ "$(jq -r '.extraction.provider' <<<"$SCANNED")" == *+ocr ]] || fail "the scan was not read with OCR"
[[ "$(jq -r '"\(.total.amountMinor) \(.total.currency)"' <<<"$SCANNED")" == '35200 JPY' ]] || fail "the yen total was not read as 35200 JPY"

if [[ -n "${SMOKE_METRICS_TOKEN:-}" ]]; then
  say "checking /metrics saw the flow"
  METRICS="$(curl -fsS -H "authorization: Bearer ${SMOKE_METRICS_TOKEN}" "${BASE}/metrics")"
  grep -q '^invoiceiq_invoice_transitions_total{to="PAID"} ' <<<"$METRICS" || fail "no PAID transition in /metrics"
  grep -q '^invoiceiq_ai_requests_total{operation="extract_document",outcome="ok"} ' <<<"$METRICS" || fail "no ai-service call in /metrics"
  grep -E '^invoiceiq_outbox_(pending|dead) ' <<<"$METRICS"
fi

say "smoke passed"
