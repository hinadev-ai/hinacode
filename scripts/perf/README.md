# Perf harness

Measures the renderer and main process of a running kkcode instance over CDP. Start an isolated
instance first (see `.agents/skills/verify-kkcode`), then:

```sh
node scripts/perf/seed.mjs <user-data-dir> <repo>            # project + threads of 5 to 200 turns
node scripts/perf/seed.mjs <user-data-dir> <repo> <projectId> # one 150-turn thread with 100 KB tool outputs
node scripts/perf/fatfill.mjs <worktree> 60000               # fake node_modules to time worktree removal
node scripts/perf/measure.mjs <port> <label> switch <threadId...>
node scripts/perf/measure.mjs <port> <label> scroll <threadId> [pxPerFrame]   # PROFILE=1 writes a .cpuprofile
node scripts/perf/measure.mjs <port> <label> archive <threadId>  # turns on worktree removal first
node scripts/perf/analyze-profile.mjs .context/perf/<label>-scroll.cpuprofile
node scripts/perf/compare.mjs <before-label> <after-label>
```

Results land in `.context/perf/`. Reload the renderer after seeding: the sidebar only reads threads at boot.

## Measure streaming Markdown

Use an instance you launched through `verify-kkcode`, with a main inspector as well as renderer CDP.
`launch.sh` does not expose a main-inspector option. Start once with the skill to prepare Xvfb and the
profile, then stop that instance and restart with the equivalent command below. Pick unused ports and
a fresh `/tmp/kk-` profile. Run from this checkout's root.

```sh
set -euo pipefail
S=.agents/skills/verify-kkcode/scripts
PORT=9362
MAIN_PORT=19362
DATA=/tmp/kk-perf-stream
REPO=$(pwd -P)
$S/launch.sh "$PORT" "$DATA"
$S/stop.sh "$DATA"

python3 scripts/perf/instrument-bundle.py

! curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null
! curl -fs "http://127.0.0.1:$MAIN_PORT/json/list" >/dev/null
setsid bash -c 'echo $$ >"$1/kk-verify.sid"; cd "$2"; exec env KKCODE_USER_DATA="$1" DISPLAY=:99 pnpm exec electron \
  --no-sandbox --disable-gpu --remote-debugging-port="$3" --inspect="127.0.0.1:$4" out/main/index.js' \
  _ "$DATA" "$REPO" "$PORT" "$MAIN_PORT" >"$DATA/electron.log" 2>&1 </dev/null &

node "$S/rpc.mjs" "$PORT" settings.get
$S/doctor.sh "$PORT" "$DATA"
```

Wait for `settings.get` to answer successfully before running `doctor.sh`. The port probes must fail
to connect before the restart; stop if either answers. The session ID remains in `kk-verify.sid`, so
`doctor.sh` verifies ownership and `stop.sh` stops exactly this instance. The profile retains the
webhook port assigned by the original skill launch.

Use an empty benchmark thread, or one with a short final user message visible at the bottom. Do not
run an agent in that thread. Persisted assistant messages must be complete and approvals resolved.
Create an empty thread in the isolated app if needed, then copy its ID from the sidebar link or
`node "$S/rpc.mjs" "$PORT" threads.list`. Do not send a prompt to an agent.

```sh
KKCODE_USER_DATA="$DATA" PARSE=1 node scripts/perf/stream.mjs "$PORT" "$MAIN_PORT" baseline "$THREAD_ID"
KKCODE_USER_DATA="$DATA" PARSE=1 PROFILE=1 node scripts/perf/stream.mjs "$PORT" "$MAIN_PORT" baseline-profile "$THREAD_ID"
```

Omit `PARSE=1` and the instrumentation step for frame measurements alone. `PROFILE=1` saves a
renderer CPU profile beside the result. Compare runs with the same `PARSE` and `PROFILE` settings;
instrumentation and profiling add overhead.

Each run verifies the renderer's file URL, main `process.cwd()`, matching BrowserWindow, and the
expected `KKCODE_USER_DATA`. It reloads the renderer, opens the sidebar link, and checks the selected
thread and persisted transcript before measuring. Reloading discards synthetic messages from the
previous run. The workload reaches the real preload event listener through main-process
`BrowserWindow.webContents.send('event', ...)`; it does not write synthetic messages to SQLite.

The fixed workload sends `message.created`, 160 `text_delta` events of 125 characters at 20 ms
intervals, and `turn_completed`. A main-process timer emits the deltas while the caller polls
completion. Frames use `performance.now()` inside rAF callbacks, so delayed JavaScript execution
appears in the gaps. One second of idle sampling must produce at least 30 frames in a visible
renderer. The run waits another 1000 ms after emission, then checks completion and final Markdown.
Visibility changes, unexpected thread events, missing deltas, and incomplete output fail the run.

`<label>-stream.json` records the workload text and SHA-256, viewport, emission timings, raw idle
and streaming gaps, long tasks, parser samples, received events, and final DOM HTML and text.
Parser statistics measure the synchronous ReactMarkdown function, including processor creation,
parse, transform, and element creation. They are not total React render time. `PARSE=1` fails if the
loaded bundle has no matching instrumentation, no parse samples, or no parse of the final text.

The instrumenter changes only the current built ReactMarkdown function. It saves the original
bundle and hash metadata under `.context/perf/` and refuses an unknown function shape or duplicate
instrumentation. Run `pnpm build` to restore `out/`; never add instrumentation to source files.

For a candidate build, stop the owned instance, run `pnpm build`, instrument again if requested, and
restart using the same command and profile. Run the doctor and use a new label:

```sh
KKCODE_USER_DATA="$DATA" PARSE=1 node scripts/perf/stream.mjs "$PORT" "$MAIN_PORT" candidate "$THREAD_ID"
node scripts/perf/compare.mjs baseline candidate
node scripts/perf/analyze-profile.mjs .context/perf/baseline-profile-stream.cpuprofile
$S/stop.sh "$DATA"
pnpm build
```

The comparator refuses different workload hashes, persisted transcripts, viewports, capture settings,
or final rendered text. It prints frame, parser, and emission deltas and saves
`baseline-candidate-stream-comparison.json`. Run several fresh labels for each build and retain idle
and emission timings alongside the frame results. A faster parse does not by itself prove smoother
frames.
