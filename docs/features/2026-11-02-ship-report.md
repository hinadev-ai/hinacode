# Ship report

Status: Building
Date: 2026-11-02

## Problem

A developer running several agents in parallel has to answer one question per thread. Is this ready to ship. Today the answer is spread across the transcript, the Changes tab and the Pull requests tab. When the pull request opens, the same facts get typed again into its description. A wrong guess costs a red pull request or a merge that was never actually checked.

## User flow

1. The thread overview card gains a Ship report section. It appears when the thread has a worktree.
2. The section shows one verdict. Ready, blocked, pending, working or no changes. Below it, one line per reason the verdict is not ready.
3. It shows the change size. Files changed with added and removed lines, counted from the worktree filesystem diff. Files an agent edited through the shell count, because the diff comes from git and not from tool events.
4. Pull request state folds into the verdict and its reasons. The existing Pull requests section below keeps the per pull request rows and actions, so the card never lists the same pull request twice. The copied Markdown does list every pull request, because the pull request description has no such section.
5. Copy Markdown copies the whole report as Markdown. The developer pastes it into the pull request description. The keyboard path is the overview card itself. The button is a normal button in tab order.

## Design

The report is derived, never stored. `src/shared/shipReport.ts` holds the typed model and two pure functions. No new table, no new rpc method, no new service.

```ts
type ShipVerdict = "ready" | "blocked" | "pending" | "working" | "empty"
type ShipReportReason =
  | "checksFailing"
  | "conflicting"
  | "changesRequested"
  | "checksPending"
  | "reviewRequired"
  | "pullRequestUnknown"
  | "changesUnknown"
  | "threadRunning"
  | "awaitingApproval"
  | "noPullRequest"
interface ShipReportPullRequest {
  url: string
  number: number
  title: string
  status: PullRequestStatus
  checks: ChecksStatus | null
  review: ReviewStatus | null
  mergeable: Mergeable
}
interface ShipReport {
  verdict: ShipVerdict
  reasons: ReadonlyArray<ShipReportReason>
  files: Changes["files"]
  added: number
  removed: number
  pullRequests: ReadonlyArray<ShipReportPullRequest>
  changesUnavailable: boolean
  unresolvedPullRequests: number
}
```

`deriveShipReport(threadStatus, changes, pullRequests)` computes the verdict as a lookup table, first match wins.

1. Any open pull request with failing checks, a conflicting merge or changes requested gives `blocked`.
2. A running thread gives `working`. A thread awaiting approval gives `working` with the `awaitingApproval` reason.
3. Any open pull request with pending checks or a required review gives `pending`. So does data that has not loaded. An unresolved pull request lookup and a diff that failed or is still loading give `pending` with `pullRequestUnknown` or `changesUnknown`, never `ready` and never a zero file count. Unknown is a state the report names, not a state it guesses past.
4. No changed files and no pull requests gives `empty`.
5. Anything else gives `ready`. Changed files with no pull request yet is ready with the `noPullRequest` reason, meaning ready to open one.

Closed and merged pull requests never block and never pend. A merged pull request with no remaining changes is `ready`.

Reasons are codes, not sentences. The renderer maps each code to a Paraglide message. `shipReportMarkdown(report, title)` maps the same codes to fixed English for the pull request description. The two surfaces cannot disagree about the verdict.

The renderer section lives in `ThreadOverview.tsx`. It reads worktree changes through `useThreadChanges`, pull request urls the same way the existing Pull requests section builds them, and statuses through `pullRequestStatusesAtom`. It derives the report during render. It holds no state and runs no effect.

New UI strings use the `ship_` prefix in all four catalogs.

## Out of scope

- Test evidence. HinaCode stores no structured test result per thread today. Inventing one from tool output text would print guesses as facts. The report reserves no field for it until a real source exists.
- Screenshots from the browser, tiny VM and devices. Artifacts carry no thread link today, so the report cannot attribute one to a thread honestly. When artifacts gain a thread id, the report gains an artifacts list in the same shape as `files`.
- Posting the report to GitHub directly. Copy and paste keeps the developer in the loop for slice 1. The Markdown is plain text with no HinaCode markup, so a later post action can reuse it unchanged.
- The phone app. The overview card is desktop only today and the report follows it.

## Verification

- `src/shared/shipReport.test.ts` covers every verdict row, the closed pull request rule, line counting and the Markdown output.
- `src/renderer/components/ShipReport.component.test.tsx` renders a blocked and a ready report and checks the clipboard receives the Markdown.
- With `verify-hinacode`, open a worktree thread with changes and a linked pull request, read the Ship report section, and copy its Markdown.
