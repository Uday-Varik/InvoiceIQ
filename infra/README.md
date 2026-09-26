# infra

| Path | Contents | Verification |
| --- | --- | --- |
| `db/init/` | Local Postgres bootstrap (roles only) | Written-unverified: runs inside the `db` container on first start |
| `terraform/` | Neon, Render and Vercel for ADR-0008 and ADR-0017 | Validated in CI against the provider schemas; apply is Written-unverified (W-UNV) |
| `observability/` | Alert rules, promtool tests, Grafana dashboard | Verified in CI by `check.sh` (promtool) |
| `k8s/` | Reference manifests only (ADR-0008 rejects K8s for now) | Written-unverified |

Nothing here is applied by CI; CI only validates. Anything labelled Written-unverified has not
been executed and should be read as a design sketch.
