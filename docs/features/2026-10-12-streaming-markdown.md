# Bound Markdown updates during streaming

Issue #12 reports repeated full parsing of the growing trailing text part. The current component memo reuses unchanged parts, but each new trailing string requires another ReactMarkdown parse.

The measured production Electron workload sends 20,000 characters in 160 deltas of 125 characters, 20 ms apart. A fixed publication cadence reduces the frequency of full parses. It reduces parser invocations without changing the parser, GFM configuration, reference resolution or component rendering.

## Data and ordering

A ready thread may have one pending group of adjacent text or reasoning deltas and one timer. The 100 ms timer starts with the first delta and never resets when more arrive. A different delta kind or another transcript event flushes the group before applying its own state change. Loading histories continue buffering raw pushes until the snapshot sequence filter runs. Unloading cancels pending work.

Approval, terminal, tool, file-change and message-replacement events remain synchronous. Text separated by a tool or reasoning part remains in separate Markdown documents. Every published string and the final string use the existing whole-document renderer.

Scrolling up cancels the list's initial bottom target as well as its automatic following. Legend List 3.6.0 retained the initial target after wheel input, so later streaming updates or a viewport resize could return the reader to the bottom. The patch in `patches/@legendapp__list@3.6.0.patch` cancels that target and synchronizes the observed scroll offset before another update runs. Keep the patch on dependency upgrades until the paced-output scenario passes with native wheel input and a viewport resize on both macOS and Linux.

## Verification

Compare candidate cadences against the same visible Electron IPC workload. Measure frame spacing, parser invocations, total parsed characters and parser time. Check references across blocks, open fences and tables, exact final DOM, tool boundaries, approval and terminal events, scrolling, typing, and unload/reload behavior. Keep raw measurements and traces under `.context/perf/`, and check logs and summaries under `.context/issue-12/`.

The 50 ms candidate reduced parsing but increased gaps above 33 ms in its comparison. The 100 ms candidate reduced both. Keep the existing whole-document renderer rather than add completed-block caching. A later reference definition can change an earlier block, and a single open fence or table can keep growing. This fix reduces parse frequency; it does not make an individual large parse cheaper.

## Measured result

Three unprofiled before-and-after captures used the same representative rich-Markdown fixture, viewport and instrumentation. Main emitted 160 valid deltas over about 3.2 seconds, followed by one second of settling. Median results were:

- ReactMarkdown invocations fell from 160 to 27.
- Time inside its synchronous parser and transformation pipeline fell from 2,304.7 ms to 431.7 ms, an 81.3% reduction.
- Total parsed characters fell from 1,610,000 to 274,000.
- The median capture's p95 frame gap fell from 108.8 ms to 31.2 ms.
- Gaps above 33 ms fell from 19 to 10.

The complete final rich-Markdown DOM matched byte for byte in all three pairs. Separate CPU profiles put 44.1% of sampled elapsed time inside the Markdown pipeline before the fix and 9.5% afterward. Profiles are excluded from the timing medians.

The original failing regression observed publication counts `[3, 5, 6]` where bounded publication requires `[1, 1, 2]`. The passing test retains the same final content and immediate completion. Unit coverage checks ordering, snapshots, independent threads and cancellation. Electron scenarios cover forward and backward references, growing and unfinished fences and tables, full-snapshot HTML equivalence, first-visible approval and terminal boundaries, tools, bottom-follow, reading above the bottom, and typing.

Use `scripts/perf/stream.mjs` and `scripts/perf/compare.mjs` as documented in [the performance harness](../../scripts/perf/README.md). Saved captures are `baseline-1` through `baseline-3` and `final-1` through `final-3`. The fixture SHA-256 is `64fa724ec151213b0d2a28336e1335b23fe325c5464bdb2e0a4a9a5dd9e6d157`.

The issue did not publish its literal 20,000-character input. This fixture matches the reported size, chunk size and cadence and includes headings, lists, tables, code and links. The before-and-after inputs are identical. Synthetic IPC events do not exercise a provider, network transport or backend persistence. These results describe a stress case and do not measure its frequency in ordinary use. Whole-document parsing remains, and sufficiently large individual parses can still delay a frame. Text targets a 100 ms publication window; approvals and terminal events flush immediately.
