import type { LinearIssue, PullRequest, PullRequestLink, Thread } from "@shared/domain.ts"
import { parseGitHubRepository } from "@shared/github.ts"
import { pullRequestNumber, type Remote } from "@/stores/pull-requests"

export function pullRequestReference(url: string) {
  const repository = parseGitHubRepository(url)
  const number = `#${pullRequestNumber(url) ?? "?"}`
  return repository === null ? number : `${repository.owner}/${repository.name} ${number}`
}

export type PullRequestNeed = "checks" | "changes" | "conflicts"

export type PullRequestProgress =
  | "conflicts"
  | "checksFailing"
  | "changesRequested"
  | "checksRunning"
  | "reviewRequired"
  | "readyToMerge"

export interface OverviewPullRequest {
  readonly url: string
  readonly threadId: string
  readonly pullRequest: PullRequest | null
  readonly error: string | null
  readonly needs: readonly PullRequestNeed[]
  readonly progress: PullRequestProgress | null
}

export interface PullRequestOverview {
  readonly attention: readonly OverviewPullRequest[]
  readonly open: readonly OverviewPullRequest[]
  readonly mergedToday: readonly OverviewPullRequest[]
  readonly merged: readonly OverviewPullRequest[]
  readonly unknown: readonly OverviewPullRequest[]
  readonly urls: readonly string[]
}

const sameLocalDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

function progressOf(
  status: PullRequest["status"] | undefined,
  checks: PullRequest["checks"],
  review: PullRequest["review"],
  mergeable: PullRequest["mergeable"] | undefined,
): PullRequestProgress | null {
  if (status !== "open" && status !== "draft") return null
  if (mergeable === "conflicting") return "conflicts"
  if (checks === "failing") return "checksFailing"
  if (review === "changesRequested") return "changesRequested"
  if (checks === "pending") return "checksRunning"
  if (review === "reviewRequired") return "reviewRequired"
  return status === "open" && mergeable === "mergeable" ? "readyToMerge" : null
}

export function pullRequestOverview(
  links: readonly PullRequestLink[],
  threads: Readonly<Record<string, Thread>>,
  pullRequests: Readonly<Record<string, Remote<PullRequest>>>,
  now: number,
): PullRequestOverview {
  const newest = new Map<string, PullRequestLink>()
  for (const link of [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const thread = threads[link.threadId]
    if (thread === undefined || thread.status === "archived" || newest.has(link.url)) continue
    newest.set(link.url, link)
  }

  const overview = { attention: [], open: [], mergedToday: [], merged: [], unknown: [] } as {
    [K in "attention" | "open" | "mergedToday" | "merged" | "unknown"]: OverviewPullRequest[]
  }
  for (const link of newest.values()) {
    const remote = pullRequests[link.url]
    const pullRequest = remote?.status === "ready" ? remote.value : null
    const snapshot = link.watch?.snapshot ?? null
    const status = pullRequest?.status ?? snapshot?.status
    if (status === "closed") continue
    const checks = pullRequest?.checks ?? snapshot?.checks ?? null
    const review = pullRequest?.review ?? snapshot?.review ?? null
    const mergeable =
      pullRequest !== null && pullRequest.mergeable !== "unknown" ? pullRequest.mergeable : snapshot?.mergeable
    const needs =
      status === "merged"
        ? []
        : [
            checks === "failing" && "checks",
            review === "changesRequested" && "changes",
            mergeable === "conflicting" && "conflicts",
          ].filter((need): need is PullRequestNeed => need !== false)
    const row = {
      url: link.url,
      threadId: link.threadId,
      pullRequest,
      error: remote?.status === "error" ? remote.message : null,
      needs,
      progress: progressOf(status, checks, review, mergeable),
    }
    const mergedAt = Date.parse(pullRequest?.mergedAt ?? "")
    if (status === undefined && row.error !== null) overview.unknown.push(row)
    else if (status === "merged" && !Number.isNaN(mergedAt) && sameLocalDay(mergedAt, now))
      overview.mergedToday.push(row)
    else if (status === "merged") overview.merged.push(row)
    else if (needs.length > 0) overview.attention.push(row)
    else overview.open.push(row)
  }
  overview.mergedToday.sort((a, b) => (b.pullRequest?.mergedAt ?? "").localeCompare(a.pullRequest?.mergedAt ?? ""))
  return { ...overview, urls: [...newest.keys()] }
}

const stateRank: Readonly<Record<string, number>> = { started: 0, unstarted: 1, triage: 2, backlog: 3 }
const LINEAR_NO_PRIORITY = 0
const RANK_AFTER_LOW_PRIORITY = 5
const priorityRank = (priority: number) => (priority === LINEAR_NO_PRIORITY ? RANK_AFTER_LOW_PRIORITY : priority)

export function sortIssues(issues: readonly LinearIssue[]): LinearIssue[] {
  const unique = new Map(issues.map((issue) => [issue.id, issue]))
  return [...unique.values()].sort(
    (a, b) =>
      (stateRank[a.state.type] ?? 4) - (stateRank[b.state.type] ?? 4) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.updatedAt.localeCompare(a.updatedAt),
  )
}

export const issueDraft = (issue: LinearIssue) => `${issue.identifier} ${issue.title}`
