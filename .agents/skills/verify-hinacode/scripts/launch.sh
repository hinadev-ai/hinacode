#!/usr/bin/env bash
# Usage: launch.sh <cdp-port> <user-data-dir> [--no-build]
# Builds the checkout, starts one isolated hinacode instance on Xvfb :99 and waits until the renderer answers rpc.
set -euo pipefail

port=${1:?cdp port, e.g. 9235}
data=${2:?user data dir, e.g. /tmp/kk-verify-userdata}
build=${3:-build}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
xvfb="$HOME/.local/xvfb/usr/bin/Xvfb"

if curl -fs "http://127.0.0.1:$port/json/version" >/dev/null; then
  echo "CDP port $port is already in use. Pick another port or run cleanup.sh for the instance that owns it." >&2
  exit 1
fi
if [[ -f "$data/kk-verify.sid" ]] && pgrep -s "$(cat "$data/kk-verify.sid")" >/dev/null; then
  echo "$data already belongs to a running instance (session $(cat "$data/kk-verify.sid"))." >&2
  exit 1
fi

if [[ ! -S /tmp/.X11-unix/X99 ]]; then
  echo "starting Xvfb :99"
  setsid "$xvfb" :99 -screen 0 1600x1000x24 -nolisten tcp >/tmp/hinacode-xvfb.log 2>&1 < /dev/null &
  for _ in $(seq 1 50); do [[ -S /tmp/.X11-unix/X99 ]] && break; sleep 0.1; done
  [[ -S /tmp/.X11-unix/X99 ]] || { echo "Xvfb did not start, see /tmp/hinacode-xvfb.log" >&2; exit 1; }
fi

if [[ "$build" != "--no-build" ]]; then
  (cd "$repo" && pnpm build >/dev/null)
fi

mkdir -p "$data"
# A new session holds the app and every agent it spawns, so cleanup.sh can stop exactly those.
# pnpm moves its children into new process groups, so the session id is the handle, not the pgid.
setsid bash -c 'echo $$ >"$1/kk-verify.sid"; cd "$2"; exec env HINACODE_USER_DATA="$1" DISPLAY=:99 pnpm exec electron \
  --no-sandbox --disable-gpu --remote-debugging-port="$3" out/main/index.js' _ "$data" "$repo" "$port" \
  >"$data/electron.log" 2>&1 </dev/null &

for _ in $(seq 1 60); do
  if node "$here/rpc.ts" "$port" settings.get >/dev/null 2>&1; then
    # A fresh profile listens for automation webhooks on 48080, which another instance may hold.
    # Moving it to 40000 + cdp port keeps instances apart.
    node "$here/rpc.ts" "$port" settings.set "{\"automations\":{\"bindHost\":\"127.0.0.1\",\"port\":$((40000 + port))}}" >/dev/null
    echo "hinacode ready: cdp=$port data=$data session=$(cat "$data/kk-verify.sid") webhook-port=$((40000 + port)) log=$data/electron.log"
    exit 0
  fi
  sleep 0.5
done
echo "hinacode did not become ready in 30s; last log lines:" >&2
tail -n 20 "$data/electron.log" >&2
exit 1
