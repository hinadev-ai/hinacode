#!/usr/bin/env bash
# Usage: scripts/ui-states/capture.sh <label> [scenario-regex]
# Screenshots every scenario in Hina Light and Hina Dark into .context/hill/<label>/ and audits each with axe-core.
# Needs the break-ui instance on CDP port 9241 (scripts/break-ui/launch.sh 9241 /tmp/kk-breakui).
set -euo pipefail
label=${1:?label}
only=${2:-.}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/.context/hill/$label"
port=${UI_STATES_PORT:-4431}
axe=${AXE_PATH:-/Users/kalan/.hinacode/scratch/20261106-031021-thread-1a199-c762688a-c040-484d-8673-f118c44725e3/axe/package/axe.min.js}
origin="http://127.0.0.1:$port"
mkdir -p "$out"
rm -f "$out/errors.txt"

node "$here/check.ts"
UI_STATES_PORT=$port node "$here/server.ts" >"$out/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
for _ in $(seq 100); do curl -sf "$origin/scenarios" >/dev/null && break || sleep 0.3; done

ab() { agent-browser --session uistates "$@"; }
settled="document.getAnimations().every(a => a.playState !== 'running' || a.timeline !== document.timeline || a.effect?.getTiming().iterations === Infinity)"

audit() {
  { cat "$axe"; echo "; typeof axe"; } | ab eval --stdin >/dev/null
  ab eval "axe.run(document, { resultTypes: ['violations'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' :: ' + (n.any[0]?.message ?? '')) }))))" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);if(typeof v==="string")v=JSON.parse(v);process.stdout.write(JSON.stringify(v,null,1))})' >"$out/$1.axe.json"
}

ab set viewport 1600 1000 >/dev/null
for scenario in $(curl -s "$origin/scenarios" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).join("\n")))' | grep -E "$only"); do
  for mode in light dark; do
    shot="$scenario-$mode"
    ready="window.__uiState?.ready === true || window.__uiState?.error != null"
    ab open "$origin/?scenario=$scenario&theme=hina-$mode" >/dev/null
    ab wait --fn "$ready" >/dev/null 2>&1 || { ab reload >/dev/null && ab wait --fn "$ready" >/dev/null; }
    error=$(ab eval "window.__uiState.error")
    [[ $error == null ]] || echo "$shot: $error" | tee -a "$out/errors.txt"
    hover=$(ab eval "window.__uiState.hover ?? ''" | tr -d '"')
    if [[ -n $hover ]]; then ab hover "$hover" >/dev/null && ab wait 800 >/dev/null; else ab mouse move 1400 900 >/dev/null; fi
    ab wait --fn "$settled" >/dev/null 2>&1 || true
    ab wait 300 >/dev/null
    ab screenshot "$out/$shot.png" >/dev/null
    audit "$shot"
    echo "$shot"
  done
done

node -e '
const fs = require("fs"), path = require("path"), dir = process.argv[1]
let serious = 0, contrast = 0
const shots = {}
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".axe.json"))) {
  const v = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
  const shot = { seriousOrCriticalNodes: 0, contrastNodes: 0 }
  for (const x of v) {
    if (x.impact === "serious" || x.impact === "critical") shot.seriousOrCriticalNodes += x.nodes
    if (x.id === "color-contrast") shot.contrastNodes += x.nodes
  }
  serious += shot.seriousOrCriticalNodes
  contrast += shot.contrastNodes
  shots[f.replace(".axe.json", "")] = shot
}
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ seriousOrCriticalNodes: serious, contrastNodes: contrast, shots }, null, 1))
console.log(JSON.stringify({ seriousOrCriticalNodes: serious, contrastNodes: contrast }))
' "$out"
