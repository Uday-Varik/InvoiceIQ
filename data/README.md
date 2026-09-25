# data

Synthetic data tooling (`invoiceiq_data`). Everything here is generated
deterministically and checked in CI with `invoiceiq-data check`.

| Path | What | How it is produced |
| --- | --- | --- |
| `redteam/taxonomy.yaml` | 61 attack and failure variants in 8 categories | Hand-written, validated against the reason catalog |
| `schemas/label.schema.json` | JSON Schema for label records | `LabelRecord.model_json_schema()` |
| `synthetic/labels.jsonl` | 150 families, one clean doc each plus 0-3 variants | Seeded generator (seed 1337) |
| `splits/{train,dev,test}.jsonl` | 80/10/10 family-safe splits | `sha256(salt:family_id) % 100` |
| `frozen/test-v1/` | Frozen test set with `MANIFEST.json` | `invoiceiq-data freeze` (never edited in place) |

Commands: `uv run invoiceiq-data build | freeze | check`.

**Family-safe** means a clean invoice and all its red-team variants always land
in the same split, so nothing is trained on a sibling of a test document.

**Tamper-evident** means the manifest records sha256 and size for every file
plus a root hash over those lines; any added, removed or edited file, or an
edited manifest, fails `check`. To change the test set, freeze a new version.
