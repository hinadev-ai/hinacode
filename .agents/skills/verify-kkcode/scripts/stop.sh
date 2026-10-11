#!/usr/bin/env bash
# Usage: stop.sh <user-data-dir>
# Stops the instance launch.sh started with <user-data-dir> (its whole session: Electron plus spawned agents)
# and keeps the data, so `launch.sh <port> <user-data-dir> --no-build` relaunches it with history intact.
set -uo pipefail
data=${1:?user data dir}
sid=$(cat "$data/kk-verify.sid" 2>/dev/null || true)
[[ -z "$sid" ]] && { echo "no instance recorded in $data"; exit 0; }
pkill -TERM -s "$sid"
for _ in $(seq 1 50); do pgrep -s "$sid" >/dev/null || break; sleep 0.1; done
pkill -KILL -s "$sid" && echo "session $sid needed SIGKILL"
rm -f "$data/kk-verify.sid"
echo "stopped session $sid"
