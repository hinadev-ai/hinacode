# Thread tabs

Status: Shipped
Date: 2026-10-26

## Problem

A developer often works with two or three threads at once: one agent implementing, one reviewing, one investigating. The sidebar lists every thread, so the working set is mixed in with everything else and has to be found again on each switch.

## User flow

- Clicking a thread in the sidebar shows it in the current tab, as a link does in a browser tab.
- `Mod+click`, middle-click, or "Open in new tab" in the row menu keeps the open thread and opens the other one in a background tab at the end of the strip.
- The strip appears above the thread once two tabs are open. Each tab shows the provider, the title and the same status mark as the sidebar.
- A tab's close button, middle-click on a tab, or the "Close tab" command closes it. Closing the open tab opens the tab to its right, else its left. Keyboard focus moves to that tab, or to the composer once the strip hides.
- Tabs persist across restarts. Too many tabs to fit scroll sideways, fade at the right edge, and keep the open tab scrolled into view.

## Design

- `useUi.tabThreadIds` holds the strip order in local storage. The open thread is the active tab, so the router stays the only source of where the user is.
- When the thread route records a visit, `navigateTabs` gives a thread without a tab the slot of the most recent thread that has one. Ctrl+Tab is navigation too, so switching to a thread without a tab swaps the current tab, and switching back swaps it again.
- Closing a tab also drops the thread from the recent list, so Ctrl+Tab stops offering threads the user is done with.
- The pure rules are `lib/threadTabs.ts`.

## Out of scope

- `Mod+W`. The window menu's Close Window takes it before the page sees it, so "Close tab" ships unbound. Binding it means changing the menu.
- Reordering tabs by dragging, and pinned tabs.

## Verification

Unit tests cover `navigateTabs`, `openTab` and `neighborTab`. In the real app, CDP mouse and key events drive `Ctrl+click` and middle-click from the sidebar, a sidebar click replacing the current tab, switching by clicking a tab, closing with the mouse and the keyboard, ten tabs in a narrow window, and a restart.
