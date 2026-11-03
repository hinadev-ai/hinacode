# Event loop watchdog

Status: Building
Date: 2026-11-03

## Problem

The main process runs everything on one event loop (ADR 0001), and SQLite is synchronous behind one connection (ADR 0003). One slow query, a large `JSON.parse` or a sync file read blocks every rpc, every agent stream and every push event until it returns. The window feels frozen and nothing says why. Today there is no signal at all: no `monitorEventLoopDelay`, no long-task log, and `HINACODE_TRACE` only helps if someone turned it on before the stall and then reads the JSONL by hand.

## User flow

There is no UI. A developer running `pnpm dev`, the packaged app from a terminal, or `hinacode serve` sees one warning per stall in the main process log:

```
main event loop stalled for 1840ms, spans open around it: rpc messages.page (1841ms), sql SELECT * FROM messages WHERE … (1838ms)
```

When stalls repeat, the first five in a minute are logged and the rest are counted. The next check after the minute is up says how many it dropped:

```
main event loop watchdog suppressed 12 stalls
```

## Design

The Linux softlockup detector (`kernel/watchdog.c`) checks a timestamp that a timer refreshes, and reports when it is too old. `hung_task` caps its reports with a warning budget, and `lib/ratelimit.c` prints "N callbacks suppressed" when a window closes. The watchdog copies all three.

`src/main/watchdog.ts` holds the whole feature.

- **Measuring.** `perf_hooks.monitorEventLoopDelay` samples the loop from libuv every 10ms, off the JavaScript heap. A scoped fiber reads the histogram's max every second, then resets it. A max over `STALL_MS` is a stall. The check runs on the same loop it watches, so it reports a stall after it ends, never during.
- **Attributing.** `traceLayer` now always installs the tracer, whether or not `HINACODE_TRACE` names a file, and feeds a `SpanLedger`. The ledger keeps the set of open spans and the spans that ended since the last check and took at least `STALL_MS`. Spans that ended faster cannot explain a stall, so the ledger stays a handful of entries. On a stall, the log names up to three of those spans, the ones whose duration is closest to the stall first. The measured delay covers the whole blocked task, so the culprit `sql` span is slightly shorter than the stall and its `rpc` parent slightly longer, and both rank ahead of unrelated slow spans. A span that was awaiting I/O across the stall can also appear, so the log says "open around it", not "caused by".
- **Rate limiting.** A `Budget` of `{ windowStart, reported, suppressed }` allows five reports per minute. The check rolls the window first, logging the suppressed count if there was one, then spends from it.
- **Wiring.** `makeAppLayer` builds one ledger and hands it to `traceLayer` and `watchdogLayer`, so Electron (`index.ts`) and `hinacode serve` (`daemon.ts`) both run the watchdog.

`STALL_MS` is 100ms. An audit of a copy of a real 187 MB database found normal busy stretches under 40ms (git spawns, the ports scan, opening a 9 MB transcript) and the first real problems at about 55ms (persisting a 5 MB message during a turn). 100ms keeps a quiet log on a healthy app and still catches a stall a user notices as a frozen window.

## Out of scope

- No metrics backend, histogram export or UI, and no counter for 50 to 100ms stretches. A log line is enough to find the next stall; a dashboard is a feature nobody has asked for.
- No stack sampling. Capturing the JavaScript stack during a stall needs the inspector or a worker thread with `--cpu-prof`, which is the job of a profiling session, not an always-on watchdog.
- No watchdog for renderer or utility processes. Their stalls do not block the rpc channel.

## Verification

- `src/main/watchdog.test.ts` drives the check loop with `TestClock` and an injected histogram. It covers the threshold, span attribution order, the five-per-minute budget and the suppressed count after the window rolls.
- In the real app with `verify-hinacode`, a blocking operation in the main process logs one stall warning that names the rpc and the span that ran it.
