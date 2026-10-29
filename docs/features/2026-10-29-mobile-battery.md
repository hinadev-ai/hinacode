# Mobile background traffic

Status: Building
Date: 2026-10-29

## Problem

The phone receives every agent's transcript, including tool output, while nobody reads it. Three mocked streaming
threads sent roughly 4,200 WebSocket frames and 97 KB per minute to a background Android app. Reconnecting a lost
socket also keeps waking the app after it leaves the foreground.

## User flow

Opening a chat streams that thread's transcript. Leaving it for another thread or tab stops the transcript stream.
Reopening reads a current snapshot before applying newer events. Backgrounding the app closes its connections.
Returning opens them again and refreshes visible data. Completion, approval, question, and secret alerts arrive
while the app is active. Socket-delivered background notifications stop with the connection.

## Design

The existing remote protocol negotiates an optional `watch` feature. A `watch` frame names the transcripts on
screen. A foreground phone receives transcript pushes only for those threads. Every foreground phone still gets
thread metadata and notification events for other threads. Clients that never send a watch keep the existing
behavior, and new phones only send watch frames supported by the server.

The phone retains cached histories when a chat loses focus. The focused chat tab owns the watch. Returning to a
chat reloads its snapshot with the existing sequence reconciliation. An unfinished snapshot from before a gap
is replaced too. A socket reconnect refreshes lists and the visible transcript through the existing ready path.

Application heartbeats, direct-address probes, and connection attempts stop in the background. Healthy and
still-connecting sockets close. Foregrounding retries immediately; mutation call keys and offline deadlines keep
their existing semantics. Keeping only metadata and notification traffic was measured first, but its background
Android CPU reduction was 51%, below the 90% budget. Closing the connection removes those remaining wakeups.

## Budget and verification

Use Release apps with `scripts/perf/battery.ts`, three mocked Claude threads, 60 seconds on Home, and 120 seconds
in the background. Alternate baseline and candidate builds on each device. Report medians, ranges, run count,
and host load. Preserve raw JSON with the comparison so another developer can recompute it.

The background budget is at least 90% fewer received bytes and Android CPU milliseconds per minute. The
foreground budget is at least 90% fewer received frames on Home. Measure an idle control separately to distinguish
notification and list work from streaming work. A background connection loss must cause zero reconnect attempts
per minute, checked with the transport's fake clock.

The iOS simulator suspends the app, so background CPU can already read zero. That metric cannot establish a CPU
improvement there. Simulator CPU, socket bytes, frames, and seconds with traffic measure work rather than physical
battery energy. Actual power measurements require physical Android and iOS devices. See the battery section in
`scripts/perf/README.md` for collection commands and limitations.

Verify a live reply in Chat, move to Files while it streams, then return and inspect the complete reply. Also
open a second thread over the first and prove only the focused chat receives transcript deltas. Background and
resume during a turn, test a disconnected desktop, and check the completion and approval notification paths.

## Measured result

Three Release captures per build on each platform, with the workload above. Baseline and quiet-socket captures
alternated. Final cutoff captures followed on the same devices. Host load varied, so the
[raw captures](../../scripts/perf/results/mobile-battery-2026-10-29.json) preserve ranges and artifact hashes.

| Metric per minute                 | Baseline | Cutoff | Change |
| --------------------------------- | -------: | -----: | -----: |
| Android background CPU, ms        |     1719 |     35 |   -98% |
| Android background received bytes |    97522 |      0 |  -100% |
| iOS background received bytes     |   209418 |      0 |  -100% |
| Android foreground frames on Home |     4381 |     93 |   -98% |
| iOS foreground frames on Home     |     4381 |     92 |   -98% |

The Android candidate's background CPU ranged from 15 to 35 ms/min, near the 25 ms/min idle control. A later
baseline control measured 1899 ms/min. Both platform budget checks pass. Simulator CPU and proxy bytes do not
measure physical energy; power acceptance remains pending connected phones.

The signed iOS app also received zero transcript deltas on Files or for a thread behind another thread. An open
chat received all 180 text and reasoning deltas per mock turn. Reopening showed the reply completed while hidden.

## Out of scope

This change adds no battery-optimization exemption, background service, or wake lock. Reliable notifications
after backgrounding, suspension, or termination require platform push delivery and are outside this change.
