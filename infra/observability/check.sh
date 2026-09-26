#!/usr/bin/env bash
# Validate alerts.yml and dashboard.json with promtool: rule syntax, rule unit
# tests, and every dashboard query (wrapped as recording rules so promtool parses
# them). Usage: infra/observability/check.sh [path/to/promtool]
set -euo pipefail
cd "$(dirname "$0")"
PROMTOOL="${1:-promtool}"

"$PROMTOOL" check rules alerts.yml
"$PROMTOOL" test rules alerts.test.yml

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP/dashboard-rules.yml" <<'PY'
import json, sys
dash = json.load(open("dashboard.json"))
exprs = [t["expr"] for p in dash["panels"] for t in p.get("targets", [])]
with open(sys.argv[1], "w") as f:
    f.write("groups:\n  - name: dashboard-queries\n    rules:\n")
    for i, e in enumerate(exprs):
        f.write(f"      - record: dashboard:query_{i}\n        expr: {json.dumps(e)}\n")
print(f"dashboard: {len(exprs)} queries")
PY
"$PROMTOOL" check rules "$TMP/dashboard-rules.yml"
