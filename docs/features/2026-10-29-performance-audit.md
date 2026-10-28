# Bundle size and performance audit

Status: Building
Date: 2026-10-29

## Problem

The renderer loads settings, terminal, syntax highlighting and experimental VM dependencies before the developer uses them.
The audit also covers long transcripts, remote connections, CPU, retained memory and React renders on desktop and mobile.

## User flow

Opening HinaCode loads the thread workspace. Settings and optional panels load their dependencies when opened.
Opening a transcript with code loads syntax highlighting. Snooze parsing loads when the picker opens.
The locale selects the Japanese or Traditional Chinese font stylesheet.

## Design

Use existing route and React lazy boundaries and dynamic imports at each dependency's first consumer.
Keep the terminal's existing backlog and attachment lifecycle. Keep reduced-motion configuration with its consumers.
Extract settings hooks used by the composer so the composer cannot import an entire settings page.

Measure every startup script listed in `index.html`, including module preloads. Count startup CSS separately from deferred CSS.
Report all chunks too. Deferral reduces startup work but does not promise a smaller installed application.
The targets are less than 2 MB startup JavaScript and less than 200 kB startup CSS, without changing production minification.

Use the existing isolated Electron and mobile Release profiling harnesses. Compare identical synthetic workloads and retain raw captures in `.context/perf/`.
Changes to runtime behavior need their own comparison, separate from the bundle changes.
On Linux, mobile store and protocol probes must be labeled as synthetic. They cannot establish native frame, CPU or memory costs.

## Baseline and accepted bundle experiments

Base is `0708258a`. The saved production artifact is `.context/perf/base-out`; named profiling builds use `base-names-out`.
The production baseline has 2,909,276 bytes of startup JavaScript and 393,952 bytes of CSS.
All renderer JavaScript totals 14,757,747 bytes. Baseline gzip startup JavaScript is 937,007 bytes using Node's default gzip settings.

| Accepted change                              | Startup JavaScript after change | Reduction |
| -------------------------------------------- | ------------------------------: | --------: |
| Lazy settings route                          |                     2,632,822 B | 276,454 B |
| Lazy VM views and local motion configuration |                     2,459,840 B | 172,982 B |
| Lazy shared syntax highlighter               |                     2,248,474 B | 211,366 B |
| Lazy terminal engine                         |                     2,121,292 B | 127,182 B |
| Lazy snooze parser                           |                     2,050,303 B |  70,989 B |
| Extract account hooks                        |                     2,024,947 B |  25,356 B |
| Lazy browser view                            |                     1,987,065 B |  37,882 B |

Selecting the CJK stylesheet by locale reduces startup CSS to 184,242 bytes, a reduction of 209,710 bytes.
Both font stylesheets remain packaged. English uses the existing system fallback for CJK text.

The final production build includes the find change and totals 1,987,281 bytes of startup JavaScript, down 31.7%.
Startup CSS remains 184,242 bytes, down 53.2%. Default gzip sizes are 663,304 and 30,643 bytes.
All renderer JavaScript grows from 14,757,747 to 14,881,523 bytes, up 0.84%, because the features remain in deferred
chunks. All CSS is 394,322 bytes. This work reduces startup size rather than installed application size.
CI now limits startup JavaScript to 2.1 MB and startup CSS to 200 kB.

## Out of scope

No dependency upgrades or new rendering framework. No transcript cache or transport redesign without a measured workload.
Native mobile timings require Xcode and a Release simulator or device capture. Historical phone results from October 24 predate native Markdown and paged transcripts.

## Verification

Run `pnpm build` and `pnpm exec size-limit --json` for the production sizes.
For React component names, build with `HINACODE_KEEP_NAMES=1`; compare only builds that use that same option.
The perf harness fixes the desktop viewport at 1280 by 820 CSS pixels so display scaling cannot hide its sidebar.

Run alternating `scripts/perf/suite.sh` captures at CPU throttle 4 for typing, switching, streaming replies and typing during a reply.
Use `scripts/perf/memory.ts` for retained history and idle CPU samples, and `scripts/perf/commits.ts` for render counts.
Drive deferred features in the isolated app and run the required typecheck, lint, unit/integration and relevant end-to-end checks.
See [the perf harness](../../scripts/perf/README.md) for workload definitions.

## Runtime findings

Five alternating captures per build use a 1280 by 820 viewport, CPU throttle 4 and named minified renderer builds.
Every capture starts at the home route. The main process and seeded data are shared; only the renderer is swapped.
Raw labels are `final-base` and `final-after`. Values below are medians; long-thread opens use its samples only.

| Desktop measurement                      |     Base | Candidate |
| ---------------------------------------- | -------: | --------: |
| Open 200-turn thread, first visit        | 249.5 ms |  260.5 ms |
| Open 200-turn thread, later visits       | 181.6 ms |  177.1 ms |
| Long-thread switch, component renders    |      444 |       446 |
| Typing, key to paint p95                 |  18.3 ms |   19.8 ms |
| Typing while streaming, key to paint p95 |  24.8 ms |   24.6 ms |
| Reply, frame gap p95                     |  16.8 ms |   16.8 ms |
| Reply, median worst frame gap            | 533.4 ms |  516.7 ms |
| Composer component renders per key       |      4.2 |       4.2 |

These results do not establish a general typing or streaming speedup. Cold long-thread opening adds 11 ms while
deferred dependencies load. Syntax grammar/tokenization remains a large first-use task in the CPU profile.

Moving find subscriptions below syntax tokenization reduced task time for twelve searches from 447.7 to 385.8 ms.
Script time fell from 259.2 to 188.3 ms, and the tokenization component rendered zero times instead of 24 after mounting.
These are medians of three alternating captures at CPU throttle 4 in a 400-message thread.
Raw labels are `find-uncached` and `find-compiler`. The React Compiler retains tokens with the mounted component.

A global 200-entry token Promise cache was rejected. In three alternating captures, reply script duration fell from
1,013 to 495 ms, but total task duration stayed at 1,783 versus 1,787 ms. Moving tokenization into a Promise changed
counter attribution. The median worst frame improved from 517 to 417 ms, while frames over 33 ms rose from eight to nine.
That tradeoff did not justify keeping source and tokens globally. Earlier captures also contained a warmed fixture
reply on one side and are excluded from the final comparison.

In one isolated retained-history pair, twelve threads each contained 128 tool calls with 64 KiB outputs, about 105 MB
in SQLite. After all threads completed in the background, renderer heap was 23.17 MiB on base and 21.06 MiB on the
candidate. Main heap was 46.94 and 46.79 MiB. Both passed the existing hidden-transcript release check.
The roughly 2.1 MiB renderer difference was also present in the empty profile, rather than a new transcript cleanup.
Raw labels are `audit-base-history` and `audit-compiler-history`.

Fifteen-second empty-profile samples found approximately 2.22% of one CPU core in main and 0.2% in the renderer on
both builds. Samples include forced GC and inspector calls. Main heap remained 45.49 MiB on both builds.
App process-tree RSS at the final sample was 674.75 versus 669.35 MiB, excluding CLIs. This single pair does not
establish an RSS improvement, and shared pages may be counted more than once. Raw labels end in `startup-memory`.

## Remote and mobile audit

[Compact remote events](2026-10-29-compact-remote-events.md) remove fields the phone never displays while preserving
complete desktop events. The reproducible synthetic 160-frame workload falls from 1,749,154 to 28,574 raw JSON bytes,
a 98.37% reduction. Nine alternating Node runs measure publication and serialization at 0.531 versus 0.222 ms for
one client and 1.267 versus 0.361 ms for three. These are schema and service measurements, not phone or network latency.
Run `node --expose-gc scripts/perf/remote.ts .context/perf/remote.json` to reproduce them.

The remaining priorities are supported by these measurements and current source:

1. `Messages.list` decodes an entire history before `threads.transcript` selects its page. Reading 2,000 synthetic
   messages totaling 88.83 MB takes a median 111.5 ms and retains about 89.3 MB of decoded heap, even though the
   compact response is 64.4 kB. Database-level paging is the next long-thread improvement to investigate.
2. Mobile retains every visited history and reloads them all on a connection generation change. A Node probe of
   the current store retained 1,655,076 serialized bytes across 25 synthetic pages and issued 25 transcript reads
   on one reload. Reconnecting one paired server can refresh histories belonging to other servers too.
3. A Chat hidden behind Files or Terminal remains mounted and subscribed. The home list also subscribes to the
   whole thread map, while every row reads the shared clock. Measure a current native capture before changing
   screen visibility or list subscriptions.
4. Native Markdown replaced the old React Markdown tree after the October 24 simulator baseline. Completion still
   mounts the whole native Markdown view, so a new capture needs native parse/layout costs as well as React commits.
5. All connected clients still receive all threads' events. Compact projection reduces bytes but leaves event count
   and subscription scope unchanged. A single message may also exceed the nominal 64 KiB page budget.

Challenge/proof/ready total 506 synthetic JSON bytes. Four HMAC calculations cost about 0.031 ms in Node.
The transport already races direct addresses with a relay delayed by 500 ms, probes on foreground and backs off
retries. Those policies need packet-loss and multi-server workloads before further changes.

Current native mobile startup, CPU, RSS and React commit times remain unmeasured on this Linux host.
The [Release phone harness](../../scripts/perf/README.md#profile-the-phone-app) requires a Mac, Xcode and a simulator.
It should next capture a long-thread open, streaming with Chat hidden, reconnecting after 25 visits, and reconnecting
one of two paired servers. The local detailed audits and probes are in `.context/perf/mobile-audit.md` and
`.context/perf/remote-audit.md`.
