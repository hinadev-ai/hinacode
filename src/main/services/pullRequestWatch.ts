import type { PullRequestDetail, PullRequestWatchSnapshot, ReviewStatus, WatchEventKind } from "../../shared/domain.ts"

/** The part of a pull request detail a watch remembers between polls. */
export const snapshotFromDetail = (detail: PullRequestDetail): PullRequestWatchSnapshot => ({
  status: detail.status,
  checks: detail.checks,
  review: detail.review,
  mergeable: detail.mergeable,
  head: detail.head,
  failingChecks: detail.checkRuns.filter((run) => run.status === "failing").map((run) => run.name),
})

const neutral = (next: PullRequestWatchSnapshot): PullRequestWatchSnapshot => ({
  status: "open",
  checks: null,
  review: null,
  mergeable: "unknown",
  head: next.head,
  failingChecks: [],
})

const toldFailing = (previous: PullRequestWatchSnapshot, next: PullRequestWatchSnapshot) =>
  previous.head === next.head ? previous.failingChecks : []

/** Failing check names in `next` that the thread has not been told about for this head. */
export const newFailingChecks = (
  previous: PullRequestWatchSnapshot | null,
  next: PullRequestWatchSnapshot,
): ReadonlyArray<string> => {
  const told = new Set(toldFailing(previous ?? neutral(next), next))
  return next.failingChecks.filter((name) => !told.has(name))
}

const isOpen = (snapshot: PullRequestWatchSnapshot) => snapshot.status === "open" || snapshot.status === "draft"

/**
 * The events a fresh snapshot carries over the one the thread was last told about, filtered to the watch's
 * interest set. A null previous snapshot reads as a neutral pull request, so a fresh watch reports checks
 * that already failed and stays quiet about checks that are merely running.
 */
export const watchEvents = (
  previous: PullRequestWatchSnapshot | null,
  next: PullRequestWatchSnapshot,
  interest: ReadonlyArray<WatchEventKind>,
): ReadonlyArray<WatchEventKind> => {
  const wants = new Set(interest)
  const before = previous ?? neutral(next)

  if (!isOpen(next)) {
    return isOpen(before) && wants.has("mergedOrClosed") ? ["mergedOrClosed"] : []
  }

  const newHead = before.head !== next.head
  const events: Array<WatchEventKind> = []
  const failingWithoutNames = next.checks === "failing" && next.failingChecks.length === 0
  if (
    newFailingChecks(previous, next).length > 0 ||
    (failingWithoutNames && (newHead || before.checks !== "failing"))
  ) {
    events.push("checksFailed")
  }
  if (next.checks === "passing" && (newHead || before.checks !== "passing")) events.push("checksPassed")
  if ((next.review === "approved" || next.review === "changesRequested") && next.review !== before.review) {
    events.push("reviewChanged")
  }
  if (next.mergeable === "conflicting" && before.mergeable !== "conflicting") events.push("conflicting")
  return events.filter((kind) => wants.has(kind))
}

const reviewText: Record<ReviewStatus, string> = {
  approved: "approved",
  changesRequested: "changes requested",
  reviewRequired: "review required",
}

const eventLines = (
  detail: PullRequestDetail,
  previous: PullRequestWatchSnapshot | null,
  kind: WatchEventKind,
): Array<string> => {
  switch (kind) {
    case "checksFailed": {
      const fresh = new Set(newFailingChecks(previous, snapshotFromDetail(detail)))
      const runs = detail.checkRuns.filter((run) => run.status === "failing" && fresh.has(run.name))
      return [
        "Checks failed:",
        ...runs.map((run) => `- ${run.name}${run.url ? `: ${run.url}` : ""}`),
        "Read the failing logs (for GitHub Actions, `gh run view <run-id> --log-failed`), find the root cause, fix it, verify locally, and push.",
      ]
    }
    case "checksPassed":
      return [
        `All checks pass on ${detail.headRef}. If the review is approved too, tell the user the pull request is ready. Do not merge it unless the user asked for that.`,
      ]
    case "reviewChanged":
      return [
        detail.review === "changesRequested"
          ? `A reviewer requested changes. Read the review with \`gh pr view ${detail.url} --comments\`, address every point, verify locally, and push.`
          : `The review is now ${detail.review ? reviewText[detail.review] : "updated"}. If the checks pass too, tell the user the pull request is ready. Do not merge it unless the user asked for that.`,
      ]
    case "conflicting":
      return [
        `The branch now conflicts with ${detail.baseRef}. Bring ${detail.baseRef} in, resolve the conflicts, verify locally, and push.`,
      ]
    case "mergedOrClosed":
      return [`The pull request was ${detail.status}, so watching has ended. No action is needed.`]
  }
}

/**
 * The wake a thread receives for `events`. Check names, branch names and the review state come from GitHub
 * and are reported as data. The message asks for the work the event calls for and never for a merge.
 */
export const watchMessage = (
  detail: PullRequestDetail,
  previous: PullRequestWatchSnapshot | null,
  events: ReadonlyArray<WatchEventKind>,
): string =>
  [
    `Pull request watch: news on ${detail.url} (branch ${detail.headRef}, base ${detail.baseRef}).`,
    "",
    ...events.flatMap((kind) => [...eventLines(detail, previous, kind), ""]),
    "Act on this in this thread. The watch stays on, so the next push, failure or review will be reported here too.",
  ]
    .join("\n")
    .trimEnd()

/** The final wake when a watch gives up on its own, so the thread learns why instead of going silent. */
export const watchStoppedMessage = (url: string, reason: string): string =>
  [
    `Pull request watch: watching ${url} has ended. ${reason}`,
    "",
    "Call the hinacode `watch_pull_request` tool if it should be watched again.",
  ].join("\n")
