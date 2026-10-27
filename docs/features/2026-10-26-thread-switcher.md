# Thread switcher

Status: Shipped
Date: 2026-10-26

## Problem

A developer steering several agents bounces between two or three threads. The sidebar lists threads by project and order, not by when they were last looked at, so going back to the thread from a minute ago means finding it again. `Mod+Shift+]` walks sidebar order, which is rarely the order the developer cares about.

## User flow

- `Ctrl+Tab` and release opens the previously viewed thread. Pressing it again goes back, like `Cmd+Tab` between two apps.
- Holding `Ctrl` and pressing `Tab` again shows the recent threads and moves the highlight down. `Shift+Tab` moves it up. Releasing `Ctrl` opens the highlighted thread with the composer focused.
- `Escape` closes the list without switching. `Enter` opens the highlighted thread. Clicking a row opens it.
- `Ctrl+Shift+Tab` starts from the oldest thread instead.

`Ctrl` is the default on every platform, because macOS keeps `Cmd+Tab` for apps. Both chords can be rebound in Settings.

## Design

- `useUi.recentThreadIds` keeps the last 10 opened threads, most recent first, in local storage. The thread route records a visit when its `threadId` changes, so the router stays the only source of where the user is.
- The two commands live in the keybinding registry. Each press opens `useUi.threadSwitcher` or moves its highlight. The switcher snapshots the recent list when it opens, so the order holds still while the user cycles. The pure logic is `lib/threadSwitcher.ts`.
- `ThreadSwitcher` listens for keyup while open. It commits once no modifier is held, and closes without switching when the window loses focus, since the keyup never arrives then.
- The list fades in after 150ms, so a quick tap switches without flashing it. The fade is opacity only and stays under reduced motion.

## Out of scope

- A thread opened in another window or on the phone does not count as a visit.
- The switcher does not search. The command palette does.

## Verification

Unit tests cover `visitRecent` and `cycleSwitcher`. In the real app, CDP key events hold `Ctrl` across several `Tab` presses: a tap, cycling to the oldest thread, `Shift` reverse, `Escape`, and from the composer and the terminal. Restart once to confirm the recent list persists.
