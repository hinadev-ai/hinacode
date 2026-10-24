# Pull request code and guide on the phone

Status: Building
Date: 2026-10-24

## Problem

The desktop PR tab gained a Code tab with the changed files and a pulls.review guide (`2026-10-23-pull-request-guide.md`), and it colors a pull request's state like GitHub. The phone still shows only the info: a developer away from the desk can merge a pull request but cannot read what it changes.

## User flow

1. A pull request screen on the phone has two tabs under its title, Info and Code. Info is the screen as it was.
2. Code shows how many files changed with their line counts, and a switch between Files and Guide. The switch stays where it was left while the app runs.
3. Files lists each file with its change mark and line counts. Tapping one opens its diff under it in one column, long lines wrapping.
4. Guide shows the summary, then the groups in review order with a category icon, label, summary and files. Notes sit on their file, or under the diff line they explain. Critical notes are marked.
5. While the desktop writes a guide, Guide says so and fills in when the `pullRequest.guide` push arrives. A guide for an older commit stays readable and says it is out of date. A failed guide offers Retry.
6. The state shows as its icon and label in the state's color, from the same table as the thread row badge. Only failing checks get a color.
7. When the project opens pull requests on linear.review, the open button says so and goes there.

## Design

- **Rpc.** `github.pullRequestFiles`, `pullRequestGuides.get` and `pullRequestGuides.retry` are not desktop-only, and the remote listener forwards `pullRequest.guide`, so the phone uses them as the renderer does. A desktop older than the guide answers the unknown method with `SchemaError`; the Code tab then asks to update the desktop.
- **Store.** `stores/pull-requests.ts` gains files per pull request head and guide state per URL, read once and refreshed by pull to refresh. The store subscribes to `pullRequest.guide` itself, so the connection provider stays as it is.
- **Guide matching.** `resolveGuide` and `groupFiles` move from the renderer to `src/shared/pullRequestGuide.ts`, so both apps match a guide to the live diff the same way. `linearReviewUrl` moves to `src/shared/github.ts` for the same reason.
- **Diff.** `lib/patch-lines.ts` splits a file's patch into hunk headers and numbered lines. The phone draws a unified diff, since a split diff needs twice the width. A long diff shows its first 300 lines and a button for the rest, so opening one file does not stall the screen.
- **Width.** The screen is one column capped at a readable width and centered, so it reads the same on a phone and in an iPad pane.

## Out of scope

- A split diff, and syntax highlighting inside the diff.
- Persisting the Files or Guide choice across launches, and the guide model setting, which stays on the desktop.
- Unlinking a pull request and collapsible sections, which the phone did not have before this change either.

## Verification

- `patch-lines.test.ts` numbers lines across hunks, and `pullRequestGuide.test.ts` (moved) still matches guides to files.
- Pair the mobile web build with an isolated desktop, link merged public pull requests to a demo thread, seed a guide row, and screenshot Info, Files, an open diff and Guide at 390x844 and 1024x1366, and on the iPad simulator.
