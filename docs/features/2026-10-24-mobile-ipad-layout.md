# Mobile app on iPad

Status: Building
Date: 2026-10-24

## Problem

The phone app only declares iPhone support and locks portrait, so on an iPad it runs as a letterboxed iPhone app that cannot rotate. Even unboxed, its one-screen-at-a-time stack wastes a 13-inch screen: the developer goes back to the list for every thread switch, and chat lines run the full width of the screen.

## User flow

1. On an iPad window at least 780 points wide (an 11-inch or larger iPad in either orientation, an iPad mini in landscape, or a wide Split View or Stage Manager window), the app shows the thread list on the left and the selected thread on the right, as Mail does.
2. Tapping a row opens that thread on the right and highlights the row. Switching threads swaps the right side without a push animation and without growing the back stack.
3. With no thread open, the right side says so.
4. Files, pull requests and Settings push inside the right side and go back to the thread with the header's back button.
5. A narrower window (an iPad mini in portrait, Slide Over, a third of a Split View, an iPhone) gets the phone layout, unchanged. Resizing between the two keeps the open thread.
6. A deep link or a notification tap opens the thread in either layout.
7. The sidebar button at the top left of the detail side hides the list, so the thread gets the full width, and brings it back. In a landscape window the list shows by default, and the app remembers when it was hidden. In a portrait window the thread takes the full width by default, and the button slides the list in over it, above a scrim. Picking anything in the list, or tapping the scrim, slides it away. With no thread open and the list hidden, the empty state offers a Show thread list button too.

## Design

- `app.json` sets `ios.supportsTablet`. The `orientation: portrait` lock stays for iPhone; Expo writes all four orientations into `UISupportedInterfaceOrientations~ipad`, which iPad multitasking requires.
- The layout comes from the window width (`useWindowDimensions`), not the device type, so a narrow iPad window is a phone. The breakpoint in `hooks/use-split-layout.ts` is the 360 pt sidebar plus a 420 pt minimum detail, so the thread is never narrower than a large phone.
- One route tree. The root layout renders `ThreadSidebar` next to the existing `Stack` when the split is on, and nothing extra otherwise. The `Stack` keeps its place in the tree, so crossing the breakpoint keeps navigation state.
- The home list body moved from `app/index.tsx` to `components/home.tsx`, shared by the phone home screen and the sidebar. In the split, the `index` route renders the empty detail state.
- `openThread` resets the stack to `index` before pushing the thread when the split is on, so the stack is always `index, thread, ...`. The thread screen shows the sidebar button in the split where the phone shows back.
- `useSidebar` in `hooks/use-split-layout.ts` decides where the list goes. A window wider than tall puts it beside the thread, and `sidebarHidden` in the stored preferences hides it there; a missing key decodes to `false`, so older preferences keep the list. A taller window slides it over the thread. That overlay is open for the route it was opened on, so any navigation closes it without an effect, and `openThread` closes it too, for the case where the developer picks the thread already open.
- Portrait overlays instead of pushing. Pushing at 820 pt leaves the thread 460 pt: tables clip and every message re-wraps each time the list opens or closes. In portrait the list is a picker the developer leaves as soon as they pick, so it should not cost the thread its width, as in Mail and Notes.
- The list stays mounted while hidden, so it keeps its scroll and search, and `aria-hidden` takes it out of VoiceOver. Beside the thread its width animates from 360 to 0 while the list keeps its width and rides the closing edge out. Over the thread it slides on `translateX`. Both use the sheets' `drawer` curve, `duration.sheet` in and `duration.base` out, as Reanimated CSS transitions, because `lib/motion.tsx` animates neither width nor x. Under Reduce Motion the list moves at once and the scrim still fades.
- Expo Router's `SplitView` (`expo-router/unstable-split-view`) was the first choice and was not used: it is alpha, iOS only (web and Android fall back to a bare `Slot`, losing the list), must be the root navigator (the app's root is a `Stack` with protected pairing routes), and its headers cannot be customized yet.
- Wide screens also cap a few widths: the thread tabs, the chat column and the Markdown file preview at a readable 720 pt, bottom sheets at 640 pt, and the banner at 560 pt. Phones are narrower than every cap, so they do not change.

## Out of scope

- Hardware keyboard shortcuts (Cmd+Enter to send, Cmd+K to search). React Native's `TextInput` reports no modifier keys on iOS.
- A three-column layout for files.
- A swipe from the left edge to open the list, and the sidebar button on the pushed Files, pull request and Settings pages. Back to the thread, then the button.
- Keeping the hidden list out of the web build's Tab order. `aria-hidden` hides it from VoiceOver and Full Keyboard Access on iOS, but React Native Web has no `inert`.
- Android tablets. `orientation: portrait` still locks them; they get the split when their window is wide enough.

## Verification

- A development build on the iPad Pro 11-inch and iPad mini simulators: the split shows on the 11-inch, rows open threads, Files and PRs push inside the detail, and the iPad mini in portrait keeps the phone layout.
- The web build driven by `agent-browser` at 820x1180, 1180x820 and 1366x1024 for the split, and 390x844 compared before and after for the unchanged phone.
- The sidebar button: hide and show in landscape on the web build and the iPad Pro 11-inch simulator, then reload with the list hidden and open a thread by URL. In portrait, open the list, pick a thread, pick the open thread, and tap the scrim; each closes it. Record a toggle with Reduce Motion on and check it has no in-between frames.
