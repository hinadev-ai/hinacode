#!/usr/bin/env bash
# Usage: cleanup.sh <cdp-port> <user-data-dir> [agent-browser-session]
# Stops the instance launch.sh started (its whole session, nothing else), closes the agent-browser
# session, and deletes <user-data-dir> with any scratch repos and worktrees inside it.
# Evidence in <repo>/.context/shots/ is never touched.
set -uo pipefail

port=${1:?cdp port}
data=${2:?user data dir}
session=${3:-}

if [[ -n "$session" ]]; then agent-browser --session "$session" close >/dev/null 2>&1 || true; fi

"$(dirname "$0")/stop.sh" "$data"

case "$data" in
  /tmp/kk-*) rm -rf "$data" ;;
  *) echo "not deleting $data: cleanup only removes /tmp/kk-* directories" >&2 ;;
esac

if ss -ltnH "sport = :$port" | grep -q .; then echo "warning: port $port is still in use" >&2; exit 1; fi
echo "cleaned: cdp=$port data=$data"
