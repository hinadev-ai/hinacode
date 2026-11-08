# Mobile redesign for Liquid Glass

## Problem

The phone app is one stack. Home carries Overview, New thread and Settings as header buttons, search sits under the title, and a thread opens on a four-way segmented control. On iOS 26 the system already draws a Liquid Glass tab bar, a search tab and a bottom accessory, and the app uses none of them. Home also treats every thread the same, so the one that waits on an approval looks like the one that finished yesterday.

The design lives in `hinacode.pen`: `iOS / Threads` (RZIKM) and its sibling `iOS / *` frames, and `Mobile / Thread tabs · C — Control bar` (rdYkv) for the thread screen.

## User flow

1. The app opens on **Threads**. The top shows how many threads wait on the developer, how many run, and how many finished today.
2. Each thread that waits shows as a ticket with the command or question, so the developer approves, denies or answers without opening the thread.
3. Running threads sit in a horizontal rail with their elapsed time. Everything else follows in the Inbox, Threads and Archived lists.
4. **Start a new thread** floats above the tab bar. Tapping it opens the new thread sheet.
5. The tab bar switches between Threads, Pull requests and Settings. Search is its own tab.
6. A thread opens with a control bar under its title: Chat, Files, PR and Terminal as icons, then Stop while a turn runs, then the access mode.

## Design

- Routes. `src/app/(tabs)/` holds a `NativeTabs` layout with four tabs: `(threads)`, `pull-requests`, `settings` and `search` (role `search`). Each tab is a stack, so it keeps its own large title and header items. Thread, file, pull request, project and server screens stay in the root stack and push over the tabs, which hides the tab bar.
- iOS 26 gets the system pieces: the glass tab bar, the search tab and `NativeTabs.BottomAccessory` for Start a new thread. Header items stay `Stack.Toolbar` items, so the system draws their glass capsules. Android gets Material bottom navigation from the same `NativeTabs`, and Start a new thread renders inside the Threads tab, above the navigation bar.
- Overview becomes the Pull requests tab. Its Linear tickets stay as the last section.
- Home reads the waiting tickets from the same `threads.transcript` history the chat uses. A ticket watches its thread while it is on screen, so an approval that resolves on the desktop leaves the phone at once.
- The thread screen drops the segmented control and the provider subheader. The header title carries a subtitle of the current tab, the status and the time since the last update. The control bar holds the tabs, Stop and the access mode picker.
- Approval and question cards take the ticket shape in both places: an age bar on top, the request, then the actions.

## Out of scope

- The activity line on running cards ("Running tests"). It needs every running transcript streamed to the phone.
- New pull request actions on the PR tab. It keeps what Overview could do.

## Verify

- Android emulator and the web build: tabs switch and keep their state, Start a new thread opens the sheet, a ticket approves, a thread's control bar switches tabs and stops a turn.
- iOS 26 simulator: the tab bar, search tab and accessory are the system's glass, and content scrolls under them.
