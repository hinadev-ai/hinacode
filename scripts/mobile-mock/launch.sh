#!/usr/bin/env bash
# Usage: scripts/mobile-mock/launch.sh <user-data-dir> [port] [--no-build]
# Starts a `hinacode serve` cloud on 127.0.0.1 filled with a scrubbed copy of your real threads, with Claude and
# Linear mocked, and forwards its port to every adb device. The first boot runs the migrations, then the cloud
# stops, seed.ts fills the database, and it starts again in the foreground. Ctrl+C stops it.
set -euo pipefail
data=${1:?user data dir outside your home, e.g. /tmp/kk-mobile}
port=${2:-48091}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)

[[ -e "$data" ]] && { echo "$data already exists; seed a fresh profile" >&2; exit 1; }
[[ "${3:-}" == "--no-build" ]] || (cd "$repo" && pnpm build:server >/dev/null)

serve() {
  HINACODE_USER_DATA="$data" HINACODE_SERVE_AUTO_UPDATE=0 HINACODE_MOCK_LINEAR=1 \
    HINACODE_MOCK_CLAUDE="${HINACODE_MOCK_CLAUDE:-approvals}" \
    exec node "$repo/out/server/daemon.js" serve --host 127.0.0.1 --port "$port"
}

mkdir -p "$data"
serve >"$data/first-boot.log" 2>&1 &
boot=$!
for _ in $(seq 1 60); do grep -q "hinacode://" "$data/first-boot.log" && break; sleep 0.5; done
kill "$boot"
wait "$boot" || true
grep -q "hinacode://" "$data/first-boot.log" || { cat "$data/first-boot.log" >&2; exit 1; }

node "$here/seed.ts" "$data"
if command -v adb >/dev/null; then
  for device in $(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }'); do
    adb -s "$device" reverse "tcp:$port" "tcp:$port" >/dev/null && echo "forwarded tcp:$port on $device"
  done
fi
serve
