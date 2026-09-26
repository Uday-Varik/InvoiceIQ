# Observability

| File | What | Verification |
| --- | --- | --- |
| `alerts.yml` | Prometheus alerting rules (availability, pipeline, security) | Verified-in-sandbox: names and runbook links checked by `tests/guardrails/observability.test.ts`; not loaded into a live Prometheus (W-UNV) |
| `dashboard.json` | Grafana dashboard for both services | Same: every query uses exported metrics; not imported into a live Grafana (W-UNV) |

Scrape `/metrics` on core-api (job `invoiceiq-core-api`) and ai-service
(job `invoiceiq-ai-service`) with `Authorization: Bearer $METRICS_TOKEN`.
How to wire it up, what each alert means and what to do:
[docs/runbooks/observability.md](../../docs/runbooks/observability.md).
