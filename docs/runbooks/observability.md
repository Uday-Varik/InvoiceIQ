# Runbook: observability and alerts

What core-api and ai-service expose, how to scrape it, the service objectives,
and what to do for each alert in
[`infra/observability/alerts.yml`](../../infra/observability/alerts.yml).
Decisions behind this are in ADR-0017.

## What is exposed

| Signal | Where | Notes |
| --- | --- | --- |
| Liveness | `GET /healthz` (both services) | Process is up. Render's health check. |
| Readiness | `GET /readyz` (core-api) | 200 when Postgres answers and every migration is applied; 503 otherwise. ai-service is reported, never required. Point an uptime monitor here. |
| Metrics | `GET /metrics` (both services) | Prometheus text. `Authorization: Bearer $METRICS_TOKEN`. In production without a token, core-api answers 404 and ai-service requires a request signature. |
| Logs | stdout, JSON lines | Every line inside a request or outbox event carries `traceId`. Authorization and cookie headers are redacted. |
| Traces | `traceparent` in, `x-trace-id` and `traceresponse` out | W3C Trace Context without an SDK: the upload's trace is stored on its outbox row and forwarded to ai-service, so one id finds every log line of an invoice's journey. |

No metric label carries a tenant, user, vendor or invoice id (enforced in code
and by `tests/guardrails/observability.test.ts`).

## Wiring it up (Grafana Cloud free tier)

1. Add two Prometheus scrape jobs: `invoiceiq-core-api` and
   `invoiceiq-ai-service`, each against `https://<service>/metrics` with the
   bearer token from `terraform output -raw metrics_token` (or Render's
   generated `METRICS_TOKEN`).
2. Import `infra/observability/dashboard.json` and pick the Prometheus data
   source.
3. Import `infra/observability/alerts.yml` as alert rules and route `page` to
   a phone, `ticket` to email or an issue tracker, `info` to a channel.
4. Add an uptime check on `https://<core-api>/readyz`.

**Free-tier caveat.** A scrape wakes a sleeping Render service. Scraping every
minute keeps both services awake around the clock, which uses more than the
free plan's monthly instance hours for two services. For the public demo,
scrape every 30 minutes or not at all and rely on the uptime check; for a
paid, always-on plan, scrape every 30 to 60 seconds and use every alert.

## Service objectives

| Objective | Target | Measured by |
| --- | --- | --- |
| API availability | 99.5% of requests not 5xx, monthly | `invoiceiq_http_requests_total` |
| API latency | p95 under 2 s, excluding uploads | `invoiceiq_http_request_duration_seconds` |
| Extraction freshness | an uploaded invoice leaves RECEIVED within 15 minutes | `invoiceiq_outbox_oldest_pending_age_seconds` |
| No silent loss | every dead-lettered event is looked at within a working day | `invoiceiq_outbox_events_total{outcome="dead"}` |

Cold starts on free plans (about a minute) are outside these objectives by
design (ADR-0008).

## Following one invoice

1. Take the `x-trace-id` from the upload response (the web app's network tab,
   or `curl -D -`).
2. Search both services' logs for that `traceId`: the upload request, the
   outbox event that extracted it, and ai-service's request lines all carry it.
3. `GET /v1/invoices/{id}` shows the audit history for the same invoice.

## Alerts

### InvoiceIQHighErrorRate

More than 5% of core-api requests fail with 5xx for 10 minutes.

1. Dashboard, "Requests by status class" and "Slowest routes": is it one route?
2. Search logs for `level":50` (pino error) with `unhandled error`; each line
   has a `traceId` to follow.
3. `GET /readyz`: a database outage shows here first. If Neon is down, the
   API fails closed (no writes), which is correct; wait or fail over.
4. A bad deploy: roll back on Render (Deploys, then the previous one).

### InvoiceIQSlowRequests

p95 latency, uploads excluded, above 2 seconds for 15 minutes.

1. "Event loop p99 and DB pool": a waiting pool means Postgres is slow or the
   pool (5) is saturated; a high event-loop delay means CPU-bound work.
2. Check Neon's dashboard for a suspended or throttled compute.
3. Export requests on large tenants are the usual suspect; they are capped at
   10,000 rows.

### InvoiceIQNotReady

`/readyz` keeps answering 503.

1. Read the body: `database.ok` false means Postgres is unreachable or the app
   role cannot log in; `migrations.ok` false names the missing migration.
2. A missing migration means core-api booted without `MIGRATION_DATABASE_URL`
   or the migrator failed: check the boot logs for `migration`.
3. A login failure after a password rotation: confirm `APP_DB_PASSWORD` and
   the password inside `DATABASE_URL` match (Terraform sets both).

### InvoiceIQEventLoopLag

core-api's event loop p99 delay above 500 ms for 10 minutes. Requests queue
behind it. Usually a large export or document; check "Slowest routes" and the
logs around the start time. Restarting clears it but hides the cause.

### InvoiceIQOutboxBacklog

The oldest pending outbox event is older than 15 minutes: uploads are not
being extracted.

1. Is core-api awake? The drain only runs while it is (ADR-0008). A request to
   `/healthz` wakes it and it drains on boot.
2. "Outbox outcomes": many `retried` means ai-service is failing; see
   InvoiceIQAiServiceUnavailable.
3. `node dist/cli/drain.js` (Render shell) drains once by hand.

### InvoiceIQOutboxDeadLetters

An event exhausted `OUTBOX_MAX_ATTEMPTS`. For `invoice.received` the invoice
is already on HOLD with `POLICY_MANUAL_REVIEW_REQUIRED`: nothing was lost, a
reviewer must look at it. Find the event's `traceId` in the `outbox event
dead-lettered` log line and fix the cause before releasing the invoice.

### InvoiceIQAiServiceUnavailable

More than half of ai-service calls fail as unavailable for 15 minutes, well
past a cold start.

1. `GET https://<ai-service>/healthz`.
2. ai-service logs: a provider outage shows as `provider_unavailable` in
   `invoiceiq_ai_extractions_total`.
3. Invoices are not at risk: failed extraction retries, then holds.
4. Scans are slower: OCR takes seconds per page. If
   `invoiceiq_ai_document_text_total{source="none"}` climbs for images or
   scanned PDFs, the OCR tools are missing from the image (ADR-0018) and those
   invoices wait for a person to type them in.

### InvoiceIQSignatureFailures

ai-service refused more than 5 unsigned or badly signed requests in 15
minutes.

- If core-api's `invoiceiq_ai_requests_total{outcome="rejected"}` rose at the
  same time, the two services disagree on `AI_SIGNING_SECRET`: set both from
  the same value (Terraform and the Render env group do).
- Otherwise someone is calling ai-service directly. It holds no data and
  cannot move invoices (ADR-0007), but note the source addresses in Render's
  logs and consider an IP allow list on a paid plan.

### InvoiceIQRateLimited

More than 50 requests refused with 429 in 10 minutes. The public demo is open,
so this is usually a script. Nothing to do unless real users complain; raise
`RATE_LIMIT_WRITES_PER_MINUTE` or `RATE_LIMIT_UPLOADS_PER_MINUTE` if they do.
If every user shares one address (a proxy in front that is not counted),
check `TRUST_PROXY_HOPS`.

### InvoiceIQHoldSpike

More than half of validated invoices went to HOLD in the last hour, with at
least ten holds. Possible causes, most to least likely:

1. A broken extractor or provider: low-confidence holds (`AI_EXTRACTION_LOW_CONFIDENCE`
   in `invoiceiq_ai_signals_total`).
2. A duplicate flood (`DUPLICATE_*` reasons on the held invoices).
3. A prompt-injection or tampering campaign (`AI_DOCUMENT_TAMPERING_SUSPECTED`).

The controls did their job either way: nothing on HOLD can be paid. Review a
sample of held invoices and their reasons before releasing any.

### InvoiceIQBankChangeBurst

More than five vendor bank-detail changes in an hour. Payment diversion almost
always starts with a changed account. Every change is already quarantined and
needs a second person's callback verification (ADR-0016); make sure nobody
verifies these in bulk, and follow
[bank-change-quarantine.md](bank-change-quarantine.md) for each.
