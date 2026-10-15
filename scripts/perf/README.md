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
  --no-sandbox --disable-gpu --use-mock-keychain --remote-debugging-port="$3" --inspect="127.0.0.1:$4" out/main/index.js' \
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

## Measure retained memory

Build first, then run from the checkout root:

```sh
pnpm build
node scripts/perf/memory.mjs baseline history
node scripts/perf/memory.mjs baseline claude
# Rebuild the candidate before repeating either workload.
node scripts/perf/memory.mjs candidate history --check
node scripts/perf/memory.mjs candidate claude --check
node scripts/perf/compare-memory.mjs baseline candidate history
node scripts/perf/compare-memory.mjs baseline candidate claude
```

Each run launches its own built Electron app through the repository's Playwright Electron driver.
It uses a fresh `/tmp/kk-memory-` profile and repository, checks the renderer path and main-process
ownership, then closes the app and removes that profile. On Linux, provide `DISPLAY` or use Xvfb.
On macOS, it uses the native window server. It never attaches to an existing app.

`history` seeds twelve running threads with 128 completed tool calls containing 64 KiB of output
per thread message. It opens each transcript through the sidebar, leaves all of them, delivers
completion pushes through the real preload boundary, and reopens the first. The data is synthetic;
no coding-agent turn runs. `--check` requires hidden histories to retain less than 20 MiB above the
seeded renderer heap. The workload contains 96 MiB of raw tool output, so this catches accumulating
histories while allowing normal UI overhead.

`claude` sends three short prompts through the composer using the real default Claude account.
These turns can incur API charges and load that account's configured hooks and MCP servers. It waits
70 seconds after the third result to sample idle processes. `--check` requires those Claude CLIs to
have exited, with no previously observed descendants left orphaned. It then sends a follow-up to
the first thread and checks that its provider session ID survives. A usage-limit result exercises
cleanup but does not prove a successful model answer.

Results and per-process RSS samples land in `.context/perf/<label>-<scenario>-memory.json`.
Screenshots land in `.context/shots/`. Renderer heap is measured after explicit garbage collection.
RSS is the sum for the owned app's process tree and can count shared pages more than once. Report it
as process-tree RSS, not private memory. Startup and thread-switch samples include temporary model
and command probes. The `claude` comparison uses the settled 70-second sample.

The comparator rejects failed captures and different workloads. It saves before, after, absolute
delta, and percentage change beside the captures. Keep the JSON and the build revision with any
performance claim. Captures also record a digest of uncommitted changes.

### 2026-10-14 capture

On macOS arm64, baseline `3941d33` and candidate `3a01bf1` used the workloads above:

| Measurement                                                   |    Baseline |  Candidate |  Change |
| ------------------------------------------------------------- | ----------: | ---------: | ------: |
| Renderer heap after twelve hidden threads finish              |  115.37 MiB |  19.11 MiB | -83.44% |
| Process-tree RSS after three Claude turns and 70 idle seconds | 3177.45 MiB | 898.33 MiB | -71.73% |

The Claude turns hit the default account's organization spend limit on both builds. Idle process
count fell from 29 to 5; no observed child processes remained orphaned. A separate successful
conversation recalled an earlier marker after its CLI exited and the next turn resumed the same
session. The 60-second grace preserves immediate follow-ups; later turns pay CLI startup time.

Raw captures use the `baseline-verified` and `final` labels. Mechanical comparisons are saved as
`.context/perf/baseline-verified-final-{history,claude}-memory-comparison.json`.

## Packaged alpha footprint

Build the release package, preserve that app, then compare packaged builds. Use an
unused renderer CDP port from 9600 to 9699; the main inspector uses that port plus 10000. The harness refuses occupied ports and verifies the launched PID, profile,
and renderer path. It clears `ELECTRON_RUN_AS_NODE`, uses `--use-mock-keychain`,
leaves GPU behavior enabled, and closes only its own app through CDP.

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist --mac -c.mac.notarize=false
ditto dist/mac-arm64/kkcode.app .context/perf/baseline.app
KKCODE_PERF_APP="$PWD/.context/perf/baseline.app/Contents/MacOS/kkcode" \
  PERF_SNAPSHOT=1 node scripts/perf/memory.mjs baseline footprint
# Build the candidate package before repeating with another preserved app and label.
KKCODE_PERF_APP="$PWD/.context/perf/candidate.app/Contents/MacOS/kkcode" \
  PERF_SNAPSHOT=1 node scripts/perf/memory.mjs candidate footprint
node scripts/perf/compare-memory.mjs baseline candidate footprint
```

`footprint` seeds three projects and thirty threads. Five transcripts each have
2,000 messages containing deterministic Markdown, tool calls, and file changes;
the remaining threads have ten messages each. No agent turns run. Model, command,
and account discovery can still launch real CLI probes without sending a prompt.
Results report app RSS and auxiliary CLI RSS separately, plus each owned process.

Samples collect both JS heaps, record main CPU usage and active resource types,
and sample every five seconds: fifteen seconds empty, fifteen seconds seeded,
then five minutes after opening and leaving ten long threads. A switch waits for
the destination's final message and two animation frames. Main and renderer CPU
profiles cover the switches, including the collections between them. Use those
profiles for diagnosis, not uninstrumented frame-rate claims.

`PERF_SNAPSHOT=1` saves both heap snapshots after the final memory sample. Set
`PERF_IDLE_SECONDS=15` for a short exploratory capture; only compare captures with
the same setting. `KKCODE_PERF_PORT=9601` selects another isolated debugger port.
The comparator rejects different workloads and failed captures. Captures include
the package's `app.asar` SHA-256, checkout revision, and working-tree diff digest.
RSS can count shared pages twice and falls when macOS reclaims pages. Report
retained JS heap separately and repeat before making an RSS or startup claim.

The packaged `70b67f4` alpha baseline captured on macOS arm64 used label
`baseline-3`. Main heap was 36.07 MiB empty, 36.80 MiB seeded, and 39.52 MiB after
ten long-thread visits and five minutes idle. Renderer heap was 10.38, 17.15, and
24.35 MiB. The final app process-tree RSS was 478.80 MiB, with 62.53 MiB of CLI RSS
reported separately. Raw capture: `.context/perf/baseline-3-footprint-memory.json`;
CPU profiles and both heap snapshots use the same label. The transcript SHA-256
was `9ebcaf6cc0b04d8410400d71e2ba6c823bdffa292737b5156b3d35bf4d2e011d`.

For repeated empty-profile startup measurements, use the same packaged invocation
with scenario `startup`. It records time from process launch to the first settings
RPC answer, renderer paint entries relative to navigation, and fifteen seconds of
empty-profile samples. Alternate package order to reduce warm-cache bias. Memory
and switch samples from `footprint` or `startup` print one JSON line per metric.

Deferring the unused Linear SDK reduced median empty-profile main heap from
36.073 to 32.623 MiB and app RSS from 608.23 to 596.45 MiB across four alternating
runs per package. After ten long-thread visits and five minutes idle, main heap
fell from 39.52 to 35.61 MiB. Explicitly importing Linear into the candidate added
3.52 MiB retained heap and 12.64 MiB RSS. Startup and thread-switch differences
were within run-to-run variation. Raw comparisons use `baseline-3` / `candidate-2`
and `baseline-repeat` / `candidate-repeat`; repeated startup labels are
`baseline-startup-1` through `4` and `candidate-startup-1` through `4`.
