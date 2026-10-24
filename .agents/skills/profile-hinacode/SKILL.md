---
name: profile-hinacode
description: Measure and compare HinaCode performance in a real isolated instance - the desktop renderer (composer typing latency, React re-renders while a reply streams, thread switch time, paint and layout work, memory) and the phone app on the iOS simulator (cold start, opening a long thread, scrolling, typing, a streaming reply). Use when a change claims to make the UI or the phone app faster, when either feels slow or janky, or when a PR needs before/after performance numbers.
---

# Profile hinacode

Measure first, read source second. Every claim compares two captures of the same workload. `scripts/perf/README.md` holds the commands and what each number means; this file is the loop.

1. Launch an isolated instance with the paced mock reply, then seed it. Follow "Profile typing, streaming and thread switching" in `scripts/perf/README.md`. Launching and cleanup come from the `verify-hinacode` skill.
2. Save the base build to `.context/perf/<label>-out` before changing code, so you can measure it again later.
3. Capture a baseline with `scripts/perf/suite.sh`. Read the per-commit lists with `scripts/perf/commits.ts`. They name which components rendered, how often and when, which source reading cannot tell you.
4. Pick the dominant cost. Usual suspects in this app:
   - A parent subscribes to a whole store slice. Look for one component group repeating once per keystroke or per publication.
   - A context value changes and every consumer re-renders. Look for `MessageBody×N` in one commit.
   - A list mounts items nobody sees. Compare `articles` in switch results with what is on screen.
   - An animation repaints every frame. Run with `TRACE=1`, then `trace-summary.ts`, then `document.getAnimations()` while it runs.
   - The React Compiler skipped a component. Check the bundle for `compilerRuntimeExports.c(` in that function. `try`/`finally` and value blocks inside `try` are the usual reasons.
5. Fix one cost, save the build under a new label, and rerun `suite.sh` with both labels so they alternate. Compare with `suite-compare.ts`. Keep a fix only when its own metric moves.
6. Put the comparison table in the PR, with the throttle rate and run count, and say what each number measures.

Stop the instance with `verify-hinacode`'s `cleanup.sh` when done.

## Phone app

The same loop works for `apps/mobile`, with `scripts/perf/mobile.ts` in place of `suite.sh`. Follow "Profile the phone app" in `scripts/perf/README.md`.

1. Launch an isolated desktop with `HINACODE_MOCK_CLAUDE=stream`, seed it with `seed.ts --list`, and turn on its remote listener on `127.0.0.1`.
2. Build each version as a Release app with `EXPO_PUBLIC_PERF_URL` set, and save it as `.context/perf/<label>.app`. Only that bundle carries the harness. A Debug build or Expo Go runs React's development build, which says nothing about what users get.
3. Run the two builds in turn with `mobile.ts run`, a few runs each, then `mobile.ts compare`. Other simulators slow this Mac down, so report the run count, the spread and the load average with the medians.
4. Read `top` in the JSON for the components behind a cost. The phone's usual suspects: a Markdown tree mounted in one commit, a hidden screen that keeps re-rendering behind the open one, a list row that re-renders with its whole list, and a store subscription that changes on every streamed delta.
