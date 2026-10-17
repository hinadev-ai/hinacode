# Phone app as a workbench

Status: Building
Date: 2026-10-18

## Problem

The phone app shipped in `2026-10-12-remote-mode.md` steers a thread, but little else. A developer away from the desk cannot add a project, find an old thread, or read a reply as anything but raw Markdown. Code blocks are gray text, and an image the agent saved, such as `![](./.context/image-1.png)`, is a line of syntax. The worktree's files are out of reach, a pull request shows only its state, and nothing tells the developer that a thread is waiting while they look at another one. Everything on screen appears and disappears without motion, so a status change or a new card is easy to miss.

## User flow

1. The home screen opens on **Inbox**: every active thread, newest activity first, with the project named on each row. **Projects** groups threads by project. **Archived** lists archived threads. Pinned threads sit above the tabs. A running thread's dot pulses and a thread that needs the developer rings, as on the desktop.
2. The search field at the top filters thread titles as they type and lists matching messages from every thread. Tapping a message opens its thread.
3. **+** opens a sheet. Pick a project to start a thread, or **Add project**. Add project takes one field, a folder on the desktop or a GitHub repository. A repository is cloned to the folder next to the newest project, which the developer can change. The new project opens on a new thread.
4. Long-pressing a thread offers Pin and Archive, or Unpin and Unarchive.
5. A reply renders as Markdown, with highlighted code blocks and a copy button. Relative images load from the thread's workspace. An image that cannot load shows its path instead of a broken frame. A finished turn folds its tool calls behind **Worked for 01:23**.
6. A thread has four tabs: Chat, Files, PRs, Terminal. **Files** browses the workspace and opens a file with line numbers and highlighting. Images open as images and Markdown files render. Its search field filters paths and searches file contents.
7. **PRs** lists linked pull requests. A pull request opens a detail page with its checks, review, mergeability and description. From there the developer can merge, close, watch, or ask the agent to fix failing checks or conflicts. Thread rows show the pull request number.
8. **Settings** holds the phone's appearance and notification choices, the desktop's defaults for new threads, and the connection with Disconnect.
9. When a thread the developer is not looking at finishes, fails or needs input, a banner slides in with Open. In the background the phone posts a system notification instead.

## Design

No main process changes. Every screen uses rpc methods the desktop already serves over remote.

### Data

- `stores/threads.ts` also loads `worktrees.list` and follows `worktree.updated`, so `threadRoot(thread)` can name the folder a thread works in: its live worktree, else the project root. `fs.*` refuses any other root.
- `stores/preferences.ts` holds the phone's own settings, decoded with a schema from the secure store (`localStorage` on web): `appearance` (`system`, `light`, `dark`), `notifications` (`completed`, `needsInput`, `failed`) and `homeTab`. Desktop settings stay on the desktop through `settings.get` and `settings.set`. `ClientSettings` stays desktop-only.
- `stores/pull-requests.ts` keeps `pullRequests.all` per thread, updated by `thread.pullRequests`, and caches `github.pullRequest` and `github.pullRequestDetail` per URL for a minute, so a list of rows costs one `gh` call per pull request.

### Markdown and highlighting

`marked` parses a reply into tokens and `components/markdown.tsx` maps them to React Native views. Text appears whole once its part finishes, as on the desktop, so each reply is parsed once. Images resolve through `lib/markdown-paths.ts`. A URL loads directly, and a path is normalized against the thread root, then read with `fs.preview`. A path outside the root, or a file that is missing or too large, renders as a muted chip with the path.

Highlighting produces the nine span classes of `gpu-lexer` with no language argument. `gpu-lexer` needs WebGPU in a secure context, which Hermes does not have and a web build over plain HTTP does not get. The web build uses it when `navigator.gpu` gives an adapter. Everywhere else a small language-agnostic lexer in `lib/highlight/` labels comments, strings, numbers, keywords, types, calls, constants and operators. Both are approximate, which is acceptable for reading code on a phone.

### Motion

Reanimated 4 with the desktop's curves from `src/renderer/index.css`: `easeOut` for entrances and press feedback, `easeDrawer` for sheets, `easeSwap` for icon swaps. Rows fade in and slide to their new place, cards rise 4 px, sheets slide over a fading scrim, the tab thumb slides, a running dot pulses, a needs-you dot rings three times, spinners turn, and loading text waits 150 ms before it shows. Under reduce motion, fades stay and movement goes.

### Notifications

`lib/thread-alerts.ts` maps a `thread.event` to an alert with the desktop's table: `turn_completed` is completed, approval, question and secret requests need input, `turn_failed` and `turn_limited` failed. A thread on screen raises nothing. Elsewhere in the app a banner slides in. In the background the phone posts a local notification through `expo-notifications`, or a web `Notification`, keyed by thread so a newer one replaces it. Tapping it opens the thread.

## Out of scope

- Push notifications while the app is closed. They need a push relay and a development build, since Expo Go on Android dropped remote push in SDK 53. Local notifications work while the app is alive. Android keeps a backgrounded app's socket for a while, but iOS suspends it within seconds.
- `gpu-lexer` in the native app. It would need a WebGPU binding such as `react-native-wgpu`, which Expo Go does not include.
- Editing files, line comments, the git graph and automations from the phone.
- Desktop-only settings such as keybindings, fonts and the remote listener itself.

## Verification

- Unit tests in `apps/mobile/src/{lib,stores}` cover the lexer, Markdown path resolution, alert mapping, the inbox and search selectors, preferences decoding and the pull request cache.
- `verify-hinacode` with `HINACODE_MOCK_CLAUDE=markdown` and the phone's web build at 390x844, driven by agent-browser: add a project by path, search a message, open the Markdown fixture with a relative image, browse and open files, open a linked public pull request, change a desktop default and see it in `settings.get`, and raise a banner by finishing a turn in another thread. Light and dark screenshots, and a short video of the motion.
