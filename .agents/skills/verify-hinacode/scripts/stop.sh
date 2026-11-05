#!/usr/bin/env bash
# Usage: stop.sh <user-data-dir>
# Stops the instance launch.sh started with <user-data-dir> (its whole session: Electron plus spawned agents)
# and keeps the data, so `launch.sh <port> <user-data-dir> --no-build` relaunches it with history intact.
set -uo pipefail
data=${1:?user data dir}
source "$(dirname "$0")/proc.sh"
sid=$(cat "$data/kk-verify.sid" 2>/dev/null || true)
[[ -z "$sid" ]] && { echo "no instance recorded in $data"; exit 0; }
# Captured up front: on macOS an agent that outlives Electron is reparented and leaves the leader's tree.
members=$(session_pids "$sid" | paste -sd, -)
running() { session_alive "$sid" || { [[ -n "$members" ]] && ps -p "$members" >/dev/null 2>&1; }; }
signal_session TERM "$sid"
[[ -n "$members" ]] && kill -TERM ${members//,/ } 2>/dev/null
for _ in $(seq 1 50); do running || break; sleep 0.1; done
if running; then
  signal_session KILL "$sid"
  [[ -n "$members" ]] && kill -KILL ${members//,/ } 2>/dev/null
  echo "session $sid needed SIGKILL"
fi
rm -f "$data/kk-verify.sid"
echo "stopped session $sid"
