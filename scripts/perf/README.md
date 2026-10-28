# Perf harness

Measures the renderer and main process of a running hinacode instance over CDP. Start an isolated
instance first (see `.agents/skills/verify-hinacode`), then:

```sh
node scripts/perf/seed.ts <user-data-dir> <repo>            # project + threads of 5 to 200 turns
node scripts/perf/seed.ts <user-data-dir> <repo> <projectId> # one 150-turn thread with 100 KB tool outputs
node scripts/perf/fatfill.ts <worktree> 60000               # fake node_modules to time worktree removal
node scripts/perf/measure.ts <port> <label> switch <threadId...>
node scripts/perf/measure.ts <port> <label> scroll <threadId> [pxPerFrame]   # PROFILE=1 writes a .cpuprofile
node scripts/perf/measure.ts <port> <label> archive <threadId>  # turns on worktree removal first
node scripts/perf/measure.ts <port> <label> typing <threadId>   # composer key-to-paint latency
node scripts/perf/measure.ts <port> <label> reply <threadId>    # needs HINACODE_MOCK_CLAUDE=stream
node scripts/perf/measure.ts <port> <label> typing-reply <threadId>  # typing while that reply streams
node scripts/perf/analyze-profile.ts .context/perf/<label>-scroll.cpuprofile
node scripts/perf/compare.ts <before-label> <after-label>
```

Results land in `.context/perf/`. Reload the renderer after seeding: the sidebar only reads threads at boot.

## Profile typing, streaming and thread switching

`measure.ts` reloads the renderer with `react-commits.js` installed where React DevTools would hook in, so
`typing`, `switch`, `reply` and `typing-reply` report which components rendered in every commit, next to the
renderer's script, style and layout time from `Performance.getMetrics`. The renderer bundle is not minified, so
component names survive the production build.

| Scenario                  | What it does                                           | Read first                                    |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `typing <threadId>`       | Types 91 characters into the composer, 50 ms apart     | Key to next paint p50 and p95, renders/key    |
| `switch <threadId...>`    | Opens each thread from the sidebar, three rounds       | Open time, renders, long tasks                |
| `reply <threadId>`        | Sends "go" and waits until the mock reply has finished | Frame gaps, renders, `MessageBody` renders    |
| `typing-reply <threadId>` | Sends "go", then types while the reply streams         | Key to next paint of keys that land mid-reply |

`reply` needs an instance started with `HINACODE_MOCK_CLAUDE=stream`. Its turn runs through the real main process:
reasoning, six reads, then the Markdown fixture in 30-character deltas every 20 ms. No account is used. Both
reply scenarios fail unless the fixture's text ends up on screen, so a failed turn cannot pass as a fast one.

To compare renderer builds, save each build and let `suite.sh` alternate them on one instance, so they share the
same data, main process and machine state. It runs under `CPU_THROTTLE=4` unless told otherwise, which makes
this machine closer to a low-end laptop.

```sh
S=.agents/skills/verify-hinacode/scripts
HINACODE_MOCK_CLAUDE=stream $S/launch.sh 9473 /tmp/kk-perf-ab
$S/seed-repo.sh /tmp/kk-perf-ab/repo && node scripts/perf/seed.ts /tmp/kk-perf-ab /tmp/kk-perf-ab/repo
pnpm build && cp -r out .context/perf/before-out   # on the base commit
pnpm build && cp -r out .context/perf/after-out    # on the change
scripts/perf/suite.sh 9473 /tmp/kk-perf-ab 5 before=.context/perf/before-out after=.context/perf/after-out
node scripts/perf/suite-compare.ts before after
```

`suite.sh` swaps only `out/renderer`, so a main-process change needs an instance per build. It refuses a label
that already has results, because `suite-compare.ts` takes the median over every run of a label. Judge latency by
p50 and p95; a single slow key or frame moves the max from run to run.

Every capture also writes `<label>-<name>.commits.json`. `commits.ts` groups its commits by which components
rendered, so a commit that repeats with more components than it needs stands out. `PROFILE=1` adds a CPU profile
for `analyze-profile.ts`. `TRACE=1` adds a trace that the DevTools Performance panel opens, and `trace-summary.ts`
totals its style, layout and paint work. Both add overhead, so compare only runs captured the same way.

### 2026-10-22 capture

On Linux under Xvfb, five interleaved runs per build at `CPU_THROTTLE=4`. The sidebar held 85 threads, and the
reply thread ended in three long fixture replies. Base is `982843a`. The candidate compiles the renderer with the
React Compiler, estimates messages at 500 px, keeps the last message id out of the shared transcript context,
moves the `text-shimmer` band with `translate`, and reads the open thread only when a thread is deleted.

| Measurement                        |    Base | Candidate | Change |
| ---------------------------------- | ------: | --------: | -----: |
| Typing, key to next paint p50      | 21.5 ms |   15.1 ms |   -30% |
| Typing, key to next paint p95      | 26.7 ms |   19.4 ms |   -27% |
| Typing mid-reply, key to paint p95 | 43.8 ms |   28.1 ms |   -36% |
| Thread switch, warm open           |  234 ms |    177 ms |   -24% |
| Thread switch, component renders   |    1604 |       507 |   -68% |
| Thread switch, long tasks          |  136 ms |      0 ms |  -100% |
| Reply, frame p95                   | 16.7 ms |    9.6 ms |   -43% |
| Reply, component renders           |    3612 |      1801 |   -50% |

A keystroke renders 4 components instead of 98. Paint events during a reply fell from about 390 to 40 in
`TRACE=1` captures once the shimmer moved to the compositor. Unthrottled, typing p50 went from 4.0 to 2.8 ms and a
warm switch from 49 to 45 ms. Raw captures use the `before3` and `after3` labels.

Deferring transcript updates with `useDeferredValue` was measured and left out. It did not move typing mid-reply,
because what still blocks a key then is commit work: LegendList measuring rows, the Markdown mount when the reply
finishes, and mermaid layout.

## Measure remote payload and transcript costs

```sh
node --expose-gc scripts/perf/remote.ts .context/perf/remote.json
```

This standalone probe uses synthetic data and the production schemas, `compactPush`, `compactMessage`, Events
layer, and Messages service. It creates an in-memory SQLite database with production migrations, so it needs no
running app or user profile. It reports raw JSON bytes, an independent per-frame deflate estimate, parse and
decode time, and publication plus serialization time for zero, one, and three clients. Full and compact fanout
workloads alternate for nine measured runs after warmup. The stream has 20 tool calls with 12 KiB inputs,
64 KiB outputs, 8 KiB diffs, and 100 text deltas.

Histories contain 200 and 2,000 messages. Each report separates complete database reads and their retained heap
increase from compacting, paging, encoding, and decoding the returned page. `--expose-gc` makes the retained heap
comparison collect garbage before and after a read. Read time includes SQL and JSON schema decoding. The current
handler reads the entire transcript before selecting its 64 KiB page, so a small response can still cost a large
allocation. The report also measures proof CPU cost and records an oversized single-message page.

These are Node CPU and byte measurements. They exclude transport, relay, TLS, compression context takeover,
Hermes, phone memory, and React rendering. Raw bytes are stable for the deterministic stream. Timing and heap
results depend on the machine. The report records CPU, Node version, load average, and sample counts.

## Profile the phone app

`mobile.ts` measures `apps/mobile` on the iOS simulator against an isolated desktop, in a Release build. It times
cold start to the thread list, opening a long thread, scrolling the thread list and that transcript, typing in the
composer, and a streamed reply. For each one it records JS frame gaps, long tasks, React commits with the
components each rendered, and React's own render time.

The harness ships only in a perf bundle. Setting `EXPO_PUBLIC_PERF_URL` at build time makes `metro.config.js` swap
React's production renderer for its profiling build, behind `apps/mobile/src/lib/perf.ts`, and keep function names.
Everything else is the Release build users get: Hermes bytecode, minified, `__DEV__` false. A normal build never
references the harness. A Debug build loads React's development renderer, so it has no harness and `mobile.ts`
times out waiting for the app.

```sh
S=.agents/skills/verify-hinacode/scripts
PORT=9305 DATA=/tmp/kk-perf-mobile UDID=<simulator udid> PERF=8105
HINACODE_MOCK_CLAUDE=stream $S/launch.sh $PORT $DATA
$S/seed-repo.sh $DATA/repo && node scripts/perf/seed.ts $DATA $DATA/repo --list
node $S/rpc.ts $PORT settings.set '{"remote":{"enabled":true,"bindHost":"127.0.0.1","port":48105}}'

cd apps/mobile && npx expo prebuild --platform ios   # once; keep app.json out of the commit
EXPO_PUBLIC_PERF_URL=http://127.0.0.1:$PERF xcodebuild -workspace ios/HinaCode.xcworkspace -scheme HinaCode \
  -configuration Release -sdk iphonesimulator -destination id=$UDID -derivedDataPath ../../.context/perf/dd build
cp -R ../../.context/perf/dd/Build/Products/Release-iphonesimulator/HinaCode.app ../../.context/perf/base.app
cd ../..

export PERF_UDID=$UDID PERF_PORT=$PERF PERF_CDP=$PORT PERF_LONG=<"long 200 turns" id> PERF_REPLY=<"small a" id>
PERF_APP=.context/perf/base.app node scripts/perf/mobile.ts run base-1
PERF_APP=.context/perf/after.app node scripts/perf/mobile.ts run after-1
# ...alternate base-2, after-2, and so on
node scripts/perf/mobile.ts compare base after
```

`seed.ts` prints the thread ids. `run` installs the app, pairs it with the desktop on first launch, then does three
cold starts and three rounds of the other workloads (`PERF_ROUNDS` changes that). It writes
`.context/perf/<label>-mobile.json` with the raw recordings, the bundle's hash and the load average.
`compare` pools every `<label>-<n>` run and prints medians with their spread.

| Measurement      | How it is taken                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold start       | `simctl launch` to the first React commit, and to the frame after the thread list has projects. Includes launching the process, with a warm file cache      |
| Open long thread | Clears the transcript cache, pushes the route, then times the fetch, the first paint after it, and the last commit that mounted a component                 |
| Scroll           | Moves the list by a fixed offset every frame from JS (`scrollToOffset`). It measures the JS and React cost of new rows, not native scrolling                |
| Typing           | Calls the composer's `onChangeText` once per character, 50 ms apart, and times each key to its commit and to the next frame. Native text input is not in it |
| Reply            | Sends "go" to the desktop's paced mock reply and records until the reply completes and paints                                                               |

Read these as relative numbers. The simulator runs on the Mac's CPU, and other simulators on the same Mac slow it
down, so alternate the two builds, compare medians, and write the load average down with them. `top` in the JSON
lists which components rendered most in each recording. For where JS time goes inside one workload, add
`react-native-release-profiler` to a throwaway build; it is not a dependency here.

Why this and not a ready-made tool: React Native DevTools' Performance panel records React tracks and JS samples,
but only in builds with the inspector, which a stock Release build leaves out. `<Profiler>` and React's commit
timings need the profiling renderer, which React Native ships in `Libraries/Renderer/implementations` but offers no
switch for. Expo's EAS Observe reports startup from Release builds, but only to a cloud dashboard. Flashlight is
Android only. So the harness uses what the Release runtime already has, `performance.now()`, the `longtask`
observer and `performance.rnStartupTiming`, plus the profiling renderer and a stand-in for the DevTools hook.

### 2026-10-24 phone capture

Release build of `8ef8ec4` with the perf harness, on an iPhone 17 Pro Max simulator (iOS 26) on an Apple silicon
Mac. Five runs, so 15 samples per number, alternated with two throwaway candidates. Other agents' simulators and
builds shared the Mac: the one-minute load average ran from 5 to 295. The thread list held 90 threads. The long
thread has 200 turns.

| Measurement                       |  Median | Spread       |
| --------------------------------- | ------: | ------------ |
| Cold start, launch to JS runtime  | 1636 ms | 1479 to 2344 |
| Cold start, bundle evaluation     |   45 ms | 37 to 114    |
| Cold start, launch to thread list | 1858 ms | 1686 to 2676 |
| Open long thread, first paint     |   44 ms | 31 to 61     |
| Open long thread, last mount      |  263 ms | 240 to 541   |
| Transcript scroll, longest commit |   10 ms | 8 to 16      |
| Typing, key to commit p50         |  3.8 ms | 2.9 to 4.5   |
| Typing, renders per key           |     7.1 | 7.1 to 28.4  |
| Reply, longest commit             |   16 ms | 13 to 21     |
| Reply, completion to paint        |   35 ms | 29 to 44     |

JS frame p95 stayed at 16.7 to 17.2 ms in every workload, with at most two frames over 33 ms. The simulator runs on
the Mac's CPU, so read commit times as a ranking. A phone is several times slower, so the largest commits are the
ones that turn into dropped frames there.

Top costs, largest first:

1. **Native startup before JS.** 1.64 s of the 1.86 s from launch to the thread list passes before React Native
   starts loading the bundle. `simctl launch` itself takes 0.2 to 0.5 s of that. Evaluating the bundle takes 45 ms,
   the first commit about 85 ms more, and loading the thread list about 140 ms more. Nothing in this capture
   attributes the native part. An `xctrace` App Launch recording on a device is the next step.
2. **A finished reply mounts its whole Markdown in one commit.** The longest commit in every reply run, 14 to 18 ms,
   mounts about 1,000 components (196 `Text`, 166 `Inline`, 120 `Block`) when the reply completes. While it
   streams, each delta re-renders only `ReplyText`, `MessageView` and `Chat`, about 0.9 ms. Cause: by design,
   `ReplyText` in `src/components/chat.tsx` shows nothing until a text part finishes, then mounts its whole
   `Markdown` tree in one commit and fades it in. Splitting that mount by block would spread it over frames.
3. **The hidden thread list re-renders every row.** With a thread open, each thread status change re-renders all
   91 `HomeRow` cells behind it, 7 to 9 ms per commit, twice per turn. A commit that is most likely the 30-second
   `useNow` tick re-renders all 90 `ThreadRow`s, each with its closed `ThreadActionsSheet` and two `Modal`s, in one
   16 ms commit. Suspected cause:
   `HomeList` in `src/app/index.tsx` subscribes to the whole `byId` map, and every row reads `useNow()` and mounts
   its own actions sheet (`src/components/thread-row.tsx`). Adding `freezeOnBlur` to the stack did not change the
   count. A smaller `windowSize` cut reply renders by 17% but cost 30 times the render time while scrolling the
   list, because rows then mount as they scroll in.
4. **Transcript batches.** Scrolling the long transcript mounts a batch of Markdown messages in commits of up to
   10 ms (`initialNumToRender={4}`, `maxToRenderPerBatch={2}` in `chat.tsx`). Opening the thread takes 13 commits
   and 263 ms to mount the visible messages, after a 44 ms first paint.
5. **Typing** costs two commits per key. One re-renders `InternalTextInput`, the other `Composer` and `Suggestions`
   (`src/components/composer.tsx`). That is about 1 ms per key, the smallest cost here.

## Measure streaming Markdown

Use an instance you launched through `verify-hinacode`, with a main inspector as well as renderer CDP.
`launch.sh` does not expose a main-inspector option. Start once with the skill to prepare Xvfb and the
profile, then stop that instance and restart with the equivalent command below. Pick unused ports and
a fresh `/tmp/kk-` profile. Run from this checkout's root.

```sh
set -euo pipefail
S=.agents/skills/verify-hinacode/scripts
PORT=9362
MAIN_PORT=19362
DATA=/tmp/kk-perf-stream
REPO=$(pwd -P)
$S/launch.sh "$PORT" "$DATA"
$S/stop.sh "$DATA"

python3 scripts/perf/instrument-bundle.py

! curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null
! curl -fs "http://127.0.0.1:$MAIN_PORT/json/list" >/dev/null
setsid bash -c 'echo $$ >"$1/kk-verify.sid"; cd "$2"; exec env HINACODE_USER_DATA="$1" DISPLAY=:99 pnpm exec electron \
  --no-sandbox --disable-gpu --remote-debugging-port="$3" --inspect="127.0.0.1:$4" out/main/index.js' \
  _ "$DATA" "$REPO" "$PORT" "$MAIN_PORT" >"$DATA/electron.log" 2>&1 </dev/null &

node "$S/rpc.ts" "$PORT" settings.get
$S/doctor.sh "$PORT" "$DATA"
```

Wait for `settings.get` to answer successfully before running `doctor.sh`. The port probes must fail
to connect before the restart; stop if either answers. The session ID remains in `kk-verify.sid`, so
`doctor.sh` verifies ownership and `stop.sh` stops exactly this instance. The profile retains the
webhook port assigned by the original skill launch.

Use an empty benchmark thread, or one with a short final user message visible at the bottom. Do not
run an agent in that thread. Persisted assistant messages must be complete and approvals resolved.
Create an empty thread in the isolated app if needed, then copy its ID from the sidebar link or
`node "$S/rpc.ts" "$PORT" threads.list`. Do not send a prompt to an agent.

```sh
HINACODE_USER_DATA="$DATA" PARSE=1 node scripts/perf/stream.ts "$PORT" "$MAIN_PORT" baseline "$THREAD_ID"
HINACODE_USER_DATA="$DATA" PARSE=1 PROFILE=1 node scripts/perf/stream.ts "$PORT" "$MAIN_PORT" baseline-profile "$THREAD_ID"
```

Omit `PARSE=1` and the instrumentation step for frame measurements alone. `PROFILE=1` saves a
renderer CPU profile beside the result. Compare runs with the same `PARSE` and `PROFILE` settings;
instrumentation and profiling add overhead.

Each run verifies the renderer's file URL, main `process.cwd()`, matching BrowserWindow, and the
expected `HINACODE_USER_DATA`. It reloads the renderer, opens the sidebar link, and checks the selected
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
HINACODE_USER_DATA="$DATA" PARSE=1 node scripts/perf/stream.ts "$PORT" "$MAIN_PORT" candidate "$THREAD_ID"
node scripts/perf/compare.ts baseline candidate
node scripts/perf/analyze-profile.ts .context/perf/baseline-profile-stream.cpuprofile
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
node scripts/perf/memory.ts baseline history
node scripts/perf/memory.ts baseline claude
# Rebuild the candidate before repeating either workload.
node scripts/perf/memory.ts candidate history --check
node scripts/perf/memory.ts candidate claude --check
node scripts/perf/compare-memory.ts baseline candidate history
node scripts/perf/compare-memory.ts baseline candidate claude
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
ditto dist/mac-arm64/hinacode.app .context/perf/baseline.app
HINACODE_PERF_APP="$PWD/.context/perf/baseline.app/Contents/MacOS/hinacode" \
  PERF_SNAPSHOT=1 node scripts/perf/memory.ts baseline footprint
# Build the candidate package before repeating with another preserved app and label.
HINACODE_PERF_APP="$PWD/.context/perf/candidate.app/Contents/MacOS/hinacode" \
  PERF_SNAPSHOT=1 node scripts/perf/memory.ts candidate footprint
node scripts/perf/compare-memory.ts baseline candidate footprint
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
the same setting. `HINACODE_PERF_PORT=9601` selects another isolated debugger port.
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

Bundling Effect with its Node and SQLite adapters in main was measured against
the lazy-Linear package. Four alternating runs per package reduced median
settings-ready startup from 759.84 to 674.80 ms, initial main CPU through the first
post-GC sample from 739.26 to 623.37 ms, and empty main heap from 32.627 to
20.000 MiB. App RSS fell from 597.20 to 582.52 MiB, excluding CLIs. These startup
runs used warm package files and fresh profiles; wall-clock ranges overlap.
The first new-package pilot took 2.09 seconds and is not used as a speed claim.

Raw labels are `linear-bundle-startup-1` through `4` for the control and
`bundled-bundle-startup-1` through `4` for the candidate, summarized in
`.context/perf/bundle-startup-summary.json`. The live debugger counted 327 external
Effect scripts in the alpha and zero in the bundled app. The packaged candidate
also completed a mock Claude turn through the composer, served an authenticated
MCP call, and restored the transcript after restart. Its full long-transcript
capture is `bundled-full-2`; the later alpha control is `alpha-final-control`.

The direct final alpha/candidate pair used the same workload and 300-second idle:
main heap 39.522 to 22.149 MiB (-43.96%), app RSS 704.89 to 685.81 MiB (-2.71%),
renderer heap 24.377 to 24.417 MiB. Older RSS captures were substantially lower in
both unchanged and changed processes. Preserve all captures and use the adjacent
pair for this long-idle RSS comparison; the repeatable heap reduction is stronger
evidence. Run `compare-memory.ts alpha-final-control bundled-full-2 footprint`.
