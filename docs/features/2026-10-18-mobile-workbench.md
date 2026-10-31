# Phone app as a workbench

Status: Shipped
Date: 2026-10-18

## Problem

The phone app shipped in `2026-10-12-remote-mode.md` steers a thread, but little else. A developer away from the desk cannot add a project, find an old thread, or read a reply as anything but raw Markdown. Code blocks are gray text, and an image the agent saved, such as `![](./.context/image-1.png)`, is a line of syntax. The worktree's files are out of reach, a pull request shows only its state, and nothing tells the developer that a thread is waiting while they look at another one. Everything on screen appears and disappears without motion, so a status change or a new card is easy to miss. Opening a long thread also downloads every tool output and diff, which the phone never shows.

## User flow

1. The home screen opens on **Inbox**: every active thread, newest activity first. **Threads** groups them by project in folding groups. **Archived** lists archived threads. Pinned threads sit above the tabs. Rows follow the desktop sidebar: the agent's mark in its brand color, the title, and the sidebar's status icon on the right (running, awaiting approval, limited, or a result not yet opened), then the project, the branch, the newest pull request number in its GitHub state color with its checks while open, and the last activity. A thread that needs the developer reads at full contrast and a running one recedes to muted and faded. Both apps take these states, icons and tones from `src/shared/threadStatus.ts`.
2. The search field at the top filters thread titles as they type and lists matching messages from every thread. Tapping either opens the thread.
3. **+** opens a sheet. Pick a project to start a thread, or **Add project**. Add project takes one field, a folder on the desktop or a GitHub repository. A repository is cloned to the folder next to the newest project, which the developer can change. The new project opens on a new thread.
4. Long-pressing a thread offers Pin and Archive, or Unpin and Unarchive.
5. A reply renders as Markdown, with highlighted code blocks and a copy button. Relative images load from the thread's workspace. An image that cannot load shows its path instead of a broken frame. A finished turn folds its tool calls behind **Worked for 1:23**, and the reply fades in whole instead of streaming word by word. Above the composer sit the agent's task list while a task is open, a usage limit with Resume at reset, and approvals that take an optional note for the agent.
6. A thread has four tabs: Chat, Files, PRs, Terminal. **Files** browses the workspace and opens a file with line numbers and highlighting. Images open as images and Markdown files render. Its search field filters paths and searches file contents with ripgrep; a content hit opens the file at its line.
7. **PRs** lists linked pull requests and the worktree branch's pull request. A pull request opens a detail page with its checks, review, mergeability and description. From there the developer can merge, close, watch, or ask the agent to fix failing checks or conflicts.
8. **Settings** holds the phone's appearance and notification choices, the desktop's defaults for new threads, and the connection with Disconnect.
9. When a thread the developer is not looking at finishes, fails or needs input, a banner slides in with Open. In the background the phone posts a system notification instead.

## Design

### Data

- `stores/threads.ts` also loads `worktrees.list` and follows `worktree.updated`, so `threadRoot(thread)` names the folder a thread works in: its live worktree, else the project root. `fs.*` refuses any other root.
- `stores/preferences.ts` holds the phone's own settings, decoded with a schema from the secure store (`localStorage` on web): `appearance`, `notifications` (`completed`, `needsInput`, `failed`) and `homeTab`. Keys an older app never wrote take their defaults. Desktop settings stay on the desktop through `settings.get` and `settings.set`; `ClientSettings` stays desktop-only.
- `stores/pull-requests.ts` keeps `pullRequests.all` per thread, replaced by `thread.pullRequests`, and caches `github.pullRequest` for a minute and `github.pullRequestDetail` for 30 seconds per URL. A watched link's snapshot gives a row its state without a `gh` call.
- `fixChecksPrompt` and `resolveConflictsPrompt` moved to `src/shared/pullRequestPrompts.ts`, so both apps ask the agent in the same words.

### Markdown and highlighting

`marked` parses a reply into tokens and `components/markdown.tsx` maps them to React Native views. Text appears whole once its part finishes, as on the desktop, so each reply is parsed once. Images resolve through `lib/markdown-paths.ts`. A URL loads directly, and a path is normalized against the thread root, or against the file's own folder in a previewed Markdown file, then read with `fs.preview`. A path outside the root, or a file that is missing or too large, renders as a muted chip with the path.

Highlighting produces the nine span classes of `gpu-lexer` with no language argument. `gpu-lexer` needs WebGPU in a secure context, which Hermes does not have and a web build over plain HTTP does not get. Every block is first colored by `lib/lexer.ts`, a small language-agnostic lexer that runs in one pass. In the web build, when `navigator.gpu` is present, `gpu-lexer`'s spans replace it once its first call has compiled its pipelines, and any failure turns it off for the session. Both are approximate, which is acceptable for reading code on a phone.

### Motion

Reanimated 4 with the desktop's curves from `src/renderer/index.css`: `ease.out` for entrances, `ease.drawer` for sheets, `ease.swap` for icon swaps. Buttons shrink on a spring while pressed, rows fade in and slide to their new place, new messages and cards rise 4 px, an answered card fades out, the send button cross-fades into Stop, sheets rise over a fading scrim, the segmented control's thumb slides, an awaiting approval icon rings three times, spinners turn, the banner drops in and lifts out, and loading text waits 150 ms before it shows. Most of it goes through `lib/motion.tsx`, a small `motion/react` for Reanimated (`2026-10-24-mobile-motion.md`). Under reduce motion, fades stay and movement goes.

### Notifications

`lib/thread-alerts.ts` maps a `thread.event` to an alert with the desktop's table: `turn_completed` is completed, approval, question and secret requests need input, `turn_failed` and `turn_limited` failed. A thread on screen raises nothing, and a finished turn with queued messages behind it raises nothing. Elsewhere in the app a banner slides in. In the background the phone posts a local notification through `expo-notifications`, or a web `Notification`, keyed by thread so a newer one replaces the older. Tapping it opens the thread.

### Performance

- `threads.transcript` takes `compact`, which leaves out tool outputs and file diffs. The phone always asks for it. A synthetic 40-turn thread drops from 3.6 MB to 0.14 MB, which matters over a cellular link and keeps long threads under the remote listener's 8 MB slow-consumer limit. Older desktops ignore the flag.
- The composer reads `files.list` only once an `@` mention needs it, instead of on every thread open and every turn.
- The transcript mounts four messages first and the rest in small batches. Opening a 30-message thread of Markdown replies in the web build paints its first code block in about 115 ms instead of 225 ms.
- The cost is bundle size. The Android bundle grows from 7.2 MB to 8.6 MB of Hermes bytecode. Most of it is Reanimated, which the app declared but never imported before (729 KB of minified JS), then `marked` (47 KB) and `expo-notifications` (35 KB). Reanimated runs the motion on the UI thread, so a press or a sheet stays smooth while JavaScript renders a long reply.

## Out of scope

- Push notifications while the app is closed. They need a push relay and a development build, since Expo Go on Android dropped remote push in SDK 53. Local notifications work while the app is alive. Android keeps a backgrounded app's socket for a while, but iOS suspends it within seconds.
- `gpu-lexer` in the native app. It would need a WebGPU binding such as `react-native-wgpu`, which Expo Go does not include.
- Editing files, line comments, the git graph and automations from the phone.
- Desktop-only settings such as keybindings, fonts and the remote listener itself.

## Verification

- Unit tests in `apps/mobile/src/{lib,stores}` cover the lexer, Markdown path resolution, file kinds, path ranking, code lines, alert mapping, relative time, project helpers, the inbox and search selectors, preferences decoding and the pull request cache. `src/shared/compactTranscript.test.ts` and `pullRequestPrompts.test.ts` cover the shared code, and `ipc.integration.test.ts` checks that `compact` drops outputs and diffs only when asked.
- `verify-hinacode` with `HINACODE_MOCK_CLAUDE=markdown`, and the phone's web build at 390x844 driven by agent-browser: clone a GitHub repository and get the duplicate-folder error, search a message, pin a thread, open the Markdown fixture and a seeded reply with a relative image and a missing one, browse files, open Python, PNG, SVG and Markdown files, jump to a content search hit, open linked pull requests, switch to dark and change the default access mode, raise a banner from another thread and post a web notification while hidden. `agent-browser --webgpu` shows every code block switching to `gpu-lexer`.
- Not covered without a device: Hermes running `marked`, OS notification delivery and taps, the permission prompts, and pinch zoom.
