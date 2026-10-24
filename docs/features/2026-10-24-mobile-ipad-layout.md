# Mobile app on iPad

Status: Building
Date: 2026-10-24

## Problem

The phone app only declares iPhone support and locks portrait, so on an iPad it runs as a letterboxed iPhone app that cannot rotate. Even unboxed, its one-screen-at-a-time stack wastes a 13-inch screen: the developer goes back to the list for every thread switch, and chat lines run the full width of the screen.

## User flow

1. On an iPad window at least 700 points wide (full screen in either orientation, or a wide Split View or Stage Manager window), the app shows the thread list on the left and the selected thread on the right, as Mail does.
2. Tapping a row opens that thread on the right and highlights the row. Switching threads swaps the right side without a push animation and without growing the back stack.
3. With no thread open, the right side says so.
4. Files, pull requests and Settings push inside the right side and go back to the thread with the header's back button.
5. A narrower window (Slide Over, a third of a Split View, an iPhone) gets the phone layout, unchanged. Resizing between the two keeps the open thread.
6. A deep link or a notification tap opens the thread in either layout.

## Design

- `app.json` sets `ios.supportsTablet`. The `orientation: portrait` lock stays for iPhone; Expo writes all four orientations into `UISupportedInterfaceOrientations~ipad`, which iPad multitasking requires.
- The layout comes from the window width (`useWindowDimensions`), not the device type, so a narrow iPad window is a phone. `hooks/use-split-layout.ts` holds the 700 pt breakpoint.
- One route tree. The root layout renders `ThreadSidebar` next to the existing `Stack` when the split is on, and nothing extra otherwise. The `Stack` keeps its place in the tree, so crossing the breakpoint keeps navigation state.
- The home list body moved from `app/index.tsx` to `components/home.tsx`, shared by the phone home screen and the sidebar. In the split, the `index` route renders the empty detail state.
- `openThread` resets the stack to `index` before pushing the thread when the split is on, so the stack is always `index, thread, ...`. The thread screen hides its back button in the split, since the list is on screen.
- Expo Router's `SplitView` (`expo-router/unstable-split-view`) was the first choice and was not used: it is alpha, iOS only (web and Android fall back to a bare `Slot`, losing the list), must be the root navigator (the app's root is a `Stack` with protected pairing routes), and its headers cannot be customized yet.
- Wide screens also cap a few widths: the chat column and the Markdown file preview at a readable 760 pt, bottom sheets at 640 pt, and the banner at 560 pt. Phones are narrower than every cap, so they do not change.

## Out of scope

- Hardware keyboard shortcuts (Cmd+Enter to send, Cmd+K to search). React Native's `TextInput` reports no modifier keys on iOS.
- Collapsing the sidebar by hand in a wide window, and a three-column layout for files.
- Android tablets. `orientation: portrait` still locks them; they get the split when their window is wide enough.

## Verification

- iPad Pro 11-inch and iPad mini simulators in Expo Go, portrait and landscape: the split shows, rows open threads, Files and PRs push inside the detail, rotation keeps the thread.
- The web build driven by `agent-browser` at 820x1180, 1180x820 and 1366x1024 for the split, and 390x844 compared before and after for the unchanged phone.
