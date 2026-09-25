# infra

| Path | Contents | Verification |
| --- | --- | --- |
| `db/init/` | Local Postgres bootstrap (roles only) | Written-unverified: runs inside the `db` container on first start |
| `terraform/` | Hosting layout for ADR-0008 | Written-unverified: not applied; Phase 4 |
| `k8s/` | Reference manifests only (ADR-0008 rejects K8s for now) | Written-unverified |

Nothing here is applied by CI. Anything labelled Written-unverified has not
been executed and should be read as a design sketch.
