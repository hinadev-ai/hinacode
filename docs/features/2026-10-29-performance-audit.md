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

| Accepted change | Startup JavaScript after change | Reduction |
| --- | ---: | ---: |
| Lazy settings route | 2,632,822 B | 276,454 B |
| Lazy VM views and local motion configuration | 2,459,840 B | 172,982 B |
| Lazy shared syntax highlighter | 2,248,474 B | 211,366 B |
| Lazy terminal engine | 2,121,292 B | 127,182 B |
| Lazy snooze parser | 2,050,303 B | 70,989 B |
| Extract account hooks | 2,024,947 B | 25,356 B |
| Lazy browser view | 1,987,065 B | 37,882 B |

Selecting the CJK stylesheet by locale reduces startup CSS to 184,242 bytes, a reduction of 209,710 bytes.
Both font stylesheets remain packaged. English uses the existing system fallback for CJK text.

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
