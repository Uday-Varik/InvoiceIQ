# ADR-0017: Phase 4: dependency-free observability, Terraform for the free-tier hosts, rate limits

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

ADR-0008 chose Neon, Render and Vercel free tiers. Phase 4 has to make that
layout reproducible and make a running deployment answerable: is it up, is the
outbox moving, is the AI failing, is someone hammering uploads or changing bank
details in bulk. Free tiers constrain the answer: Render's free services sleep,
cannot run sidecars, and give no managed Prometheus; every dependency added to
core-api is also supply-chain surface for a service that moves money.

## Decision

- **Prometheus text format, written by hand.** core-api and ai-service each
  carry a small registry (counters, gauges, histograms) and serve `/metrics`.
  Labels are bounded enums and route templates; tenant, user, vendor and
  invoice ids never appear, and each metric is capped at 500 series. Domain
  counters (transitions, payment runs closed, bank changes requested) count
  only after the transaction commits, from outbox events.
- **`/metrics` needs a bearer token in production.** `METRICS_TOKEN` is compared
  in constant time; without one, production answers 404. ai-service also
  accepts its request signature.
- **W3C trace context without an SDK.** core-api reads or starts a
  `traceparent`, keeps it in AsyncLocalStorage, stores it on each outbox row
  and sends a child span to ai-service. Both services log JSON lines with the
  trace id and return it as `x-trace-id`, so one invoice can be followed from
  upload through extraction in the logs.
- **`/readyz` is separate from `/healthz`.** Ready means the database answers
  and every migration the build ships is applied; ai-service is reported but
  never required, because extraction retries through the outbox.
- **Per-address rate limits in process.** Token buckets for writes (120 per
  minute) and uploads (20 per minute); reads are never limited. One instance
  per free tier makes a shared store unnecessary.
- **Terraform describes the hosts; it is not applied from CI.** Neon, Render
  and Vercel resources live in `infra/terraform`, with generated secrets
  (app role password, signing secret, metrics token, checkpoint key) held in
  state. CI runs `fmt`, `init` and `validate` against the real provider schemas.
- **The app role gets its password from the migrator.** `APP_DB_PASSWORD` makes
  boot give `invoiceiq_app` LOGIN after migrating. The role is not created
  through Neon's API, because Neon grants API-created roles `neon_superuser`,
  which could bypass row-level security (ADR-0004). Boot refuses to continue if
  the role is a superuser or has BYPASSRLS.
- **Alerts and a dashboard are files.** `infra/observability` holds Prometheus
  alert rules with promtool unit tests and a Grafana dashboard, each alert
  linked to a runbook section. A guardrail checks that every metric they use
  is actually exported.

## Consequences

- A free-tier deployment is only as observable as its scraper: Grafana Cloud's
  free tier can scrape a public HTTPS endpoint, but scrapes wake a sleeping
  Render service, and a sleeping service reports nothing. The runbook says so.
- Rate limits reset on restart and are per instance; scaling out needs a
  shared store.
- Terraform state contains secrets and must live in an encrypted backend.
- Hand-written metrics and tracing are small and tested, but lack exemplars,
  OTLP export and automatic library instrumentation.
- Applying the Terraform and wiring a live Grafana stack remain unverified
  (W-UNV) until hosting accounts exist.

## Alternatives considered

- **OpenTelemetry SDK and prom-client.** Standard and richer, but around forty
  transitive packages across two languages for features a free-tier demo does
  not use. The wire formats chosen (Prometheus text, W3C `traceparent`) let a
  later ADR swap them in without changing dashboards or log queries.
- **Provider-native logs only.** Render and Vercel logs exist, but cannot alert
  on outbox backlog or bank-change bursts.
- **Pulumi or provider dashboards (ClickOps).** Pulumi needs a runtime and an
  account; ClickOps is not reviewable. Terraform providers exist for all three
  hosts.
- **Redis-backed rate limiting.** Correct across instances, but another free
  tier to run for a single instance that does not need it.
