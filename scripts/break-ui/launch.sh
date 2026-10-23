#!/usr/bin/env bash
# Usage: scripts/break-ui/launch.sh <cdp-port> <user-data-dir> [--no-build]
# Starts an isolated instance seeded with worst-case data. The first launch runs the migrations, then the instance
# stops, seed.ts fills the database, and it starts again on the same profile. Drive and clean it up with the
# verify-hinacode skill (`cleanup.sh <port> <user-data-dir>`).
set -euo pipefail
port=${1:?cdp port, e.g. 9241}
data=${2:?user data dir, must start with /tmp/kk-}
here=$(dirname "$0")
verify="$here/../../.agents/skills/verify-hinacode/scripts"

[[ -e "$data" ]] && { echo "$data already exists; seed a fresh profile" >&2; exit 1; }
"$verify/launch.sh" "$port" "$data" ${3:+"$3"}
"$verify/stop.sh" "$data"
node "$here/seed.ts" "$data"
"$verify/launch.sh" "$port" "$data" --no-build
