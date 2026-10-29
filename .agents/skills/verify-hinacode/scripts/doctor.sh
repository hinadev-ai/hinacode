#!/usr/bin/env bash
# Usage: doctor.sh <cdp-port> <user-data-dir>
# Read-only. Exits 0 only when the instance on <cdp-port> was started by launch.sh with <user-data-dir>,
# runs this checkout's build, and answers rpc.
set -uo pipefail

port=${1:?cdp port}
data=${2:?user data dir}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
fail=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; fail=1; }
warn() { echo "warn  $*"; }

# Agent CLIs that Electron spawns inherit its listening sockets, and Muse Code runs in a session of its own, so the
# owner of a port is the holder whose parent does not hold it too.
listener() {
  local holders
  holders=$(ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
  for pid in $holders; do
    grep -qx "$(ps -o ppid= -p "$pid" | tr -d ' ')" <<<"$holders" || { echo "$pid"; return; }
  done
}

sid=$(cat "$data/kk-verify.sid" 2>/dev/null || true)
if [[ -n "$sid" ]] && pgrep -s "$sid" >/dev/null; then ok "session $sid alive"; else bad "no live session recorded in $data/kk-verify.sid"; fi
# Chromium overwrites its own /proc/<pid>/environ, so read the env from the session leader (pnpm).
env_data=$(tr '\0' '\n' <"/proc/$sid/environ" 2>/dev/null | sed -n 's/^HINACODE_USER_DATA=//p')
[[ "$env_data" == "$data" ]] && ok "HINACODE_USER_DATA=$env_data" || bad "instance uses HINACODE_USER_DATA='$env_data', expected '$data'"

owner=$(listener "$port")
if [[ -z "$owner" ]]; then
  bad "nothing listens on CDP port $port"
else
  owner_sid=$(ps -o sid= -p "$owner" | tr -d ' ')
  [[ "$owner_sid" == "$sid" ]] && ok "CDP port $port owned by pid $owner in our session" || bad "CDP port $port belongs to session $owner_sid, not ours ($sid). Do not drive it."
fi

page_url=$(curl -fs "http://127.0.0.1:$port/json" 2>/dev/null | grep -o '"url": *"file://[^"]*renderer/index.html"' | head -1)
[[ "$page_url" == *"$repo/out/renderer/index.html"* ]] && ok "renderer from $repo/out" || bad "renderer page is '${page_url:-missing}', expected this checkout's out/renderer"

if settings=$(node "$here/rpc.ts" "$port" settings.get 2>&1); then
  ok "rpc answers: $(echo "$settings" | tr -d ' \n' | cut -c1-160)"
  hook_port=$(echo "$settings" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).automations.port))')
  hook_owner=$(listener "$hook_port")
  if [[ -n "$hook_owner" && "$(ps -o sid= -p "$hook_owner" | tr -d ' ')" == "$sid" ]]; then
    ok "webhook listener on $hook_port is ours"
  else
    warn "webhook port $hook_port is not held by this instance (automations will report listenError)"
  fi
else
  bad "rpc settings.get failed: $settings"
fi

newest_src=$(find "$repo/src" "$repo/messages" -type f -newer "$repo/out/main/index.js" -not -path '*/paraglide/*' 2>/dev/null | head -1)
[[ -z "$newest_src" ]] && ok "build is newer than src/ and messages/" || warn "stale build: $newest_src changed after out/ was built; relaunch without --no-build"

exit $fail
