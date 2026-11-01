# Turn changes card and follow scroll

Status: Building
Date: 2026-11-01

## Problem

When a turn ends, the developer has to open the side panel to learn whether the agent touched any files, and there is no quick way to throw a bad turn's edits away.

While a turn streams, the transcript snaps to the bottom on every update. Scrolling up to reread something fights the agent, and after scrolling away there is no quick way back.

## User flow

1. The developer sends a message. The transcript scrolls smoothly until that message sits at the top of the view, with the reply growing below it.
2. While the reply grows past the bottom edge, the transcript follows it with smooth scrolling, as long as the developer has not scrolled.
3. Scrolling up with the wheel, touchpad, scrollbar or keyboard stops the following. A round button above the composer jumps to the latest message and resumes following. Scrolling back to the bottom by hand resumes it too.
4. When the turn ends and it changed files, a card closes the reply: "Edited `a.ts`" or "Edited 3 files", with `+12 -4`.
   - **View changes** opens the Changes panel on the Latest turn scope.
   - **Undo** restores every file the turn changed to how it was when the turn started, then the card goes away.

## Design

- **Scroll.** `MessageList` keeps two flags. `following` drives LegendList's `maintainScrollAtEnd`, and `atEnd` comes from `getState().isAtEnd` in `onScroll`. `anchoredEndSpace` anchors the latest user message, so the end of the list puts that message at the top while the reply is short. A `wheel` upward, `touchmove`, scroll keys or a press on the scrollbar clears `following`. A new user message at the end sets it again and calls `scrollToEnd({ animated: true })`.
- **Card.** `TurnChanges` renders under the last assistant message once it completes, only in the thread view. It reads `threads.changes` with scope `turn` through an atom keyed by message id, so each finished turn fetches fresh data. Line counts come from the patch.
- **Undo.** New rpc `threads.undoTurn`. `Threads.undoTurn` diffs the working tree against `turn_base_tree`, runs `git restore --source=<base> --worktree` on the paths that existed at the base, and deletes the paths the turn added. It refuses while the thread runs. The index is left alone.
- **View changes.** The Changes panel's scope moves from local state into the `ui` store, so the card can open it on Latest turn.

## Out of scope

- Cards for earlier turns. Only the latest turn has a stored base tree.
- Redo after Undo.
- Undo for changes outside the thread's working directory or in commits the agent made.

## Verification

- `Threads` test against a temp git repo: a turn modifies, adds and deletes files, Undo restores all three and leaves other edits alone.
- Unit tests for the patch line count and the follow state.
- `verify-hinacode`: send a message in a seeded thread and watch the anchor, scroll up mid-turn and see the button, click it, then check the card's View changes and Undo against `git status`.
