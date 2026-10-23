#!/usr/bin/env bash
set -euo pipefail
port=$1 data=$2 runs=$3
shift 3
cd "$(dirname "$0")/../.."
thread() { sqlite3 "$data/hinacode.sqlite" "select id from thread where title = '$1'"; }
long=$(thread "long 200 turns") medium=$(thread "medium 40 turns") small=$(thread "small a") reply=$(thread "small b")
[[ -n $long && -n $medium && -n $small && -n $reply ]] || { echo "seed the profile with scripts/perf/seed.ts first" >&2; exit 1; }
seeded=$(sqlite3 "$data/hinacode.sqlite" "select max(created_at) from message where thread_id = '$reply'")
for build in "$@"; do
  [[ -f ${build#*=}/renderer/index.html ]] || { echo "no renderer build in ${build#*=}" >&2; exit 1; }
  if compgen -G ".context/perf/${build%%=*}-[0-9]*-*.json" >/dev/null; then
    echo "results for ${build%%=*} already exist in .context/perf; pick a new label" >&2
    exit 1
  fi
done

mv out/renderer out/renderer.suite-backup
trap 'rm -rf out/renderer && mv out/renderer.suite-backup out/renderer' EXIT
export CPU_THROTTLE=${CPU_THROTTLE:-4}
for n in $(seq "$runs"); do
  for build in "$@"; do
    label=${build%%=*}
    rm -rf out/renderer && cp -r "${build#*=}/renderer" out/renderer
    node scripts/perf/measure.ts "$port" "$label-$n" typing "$long" >/dev/null
    node scripts/perf/measure.ts "$port" "$label-$n" switch "$long" "$medium" "$small" >/dev/null
    for scenario in reply typing-reply; do
      node scripts/perf/measure.ts "$port" "$label-$n" "$scenario" "$reply" >/dev/null
      sqlite3 "$data/hinacode.sqlite" "delete from message where thread_id = '$reply' and created_at > '$seeded'"
    done
    echo "run $n $label done"
  done
done
