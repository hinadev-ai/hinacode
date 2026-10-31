import type { LinearIssue, PullRequest, PullRequestLink, Thread } from "@shared/domain.ts"
import { parseGitHubRepository } from "@shared/github.ts"
import { pullRequestNumber, type Remote } from "@/stores/pull-requests"

/** `owner/repo #123`, read from the URL, so a row can name its pull request before or without GitHub's answer. */
export function pullRequestReference(url: string) {
  const repository = parseGitHubRepository(url)
  const number = `#${pullRequestNumber(url) ?? "?"}`
  return repository === null ? number : `${repository.owner}/${repository.name} ${number}`
}

/** Why an open pull request waits on the developer. */
export type PullRequestNeed = "checks" | "changes" | "conflicts"

export interface OverviewPullRequest {
  readonly url: string
  /** The thread of the newest link, when several threads linked the same pull request. */
  readonly threadId: string
  /** Null until GitHub answers. */
  readonly pullRequest: PullRequest | null
  readonly error: string | null
  readonly needs: readonly PullRequestNeed[]
}

export interface PullRequestOverview {
  /** Open pull requests with failing checks, changes requested or conflicts. */
  readonly attention: readonly OverviewPullRequest[]
  readonly open: readonly OverviewPullRequest[]
  readonly merged: readonly OverviewPullRequest[]
  /** Every pull request worth reading from GitHub: the ones linked to a thread that is not archived. */
  readonly urls: readonly string[]
}

/**
 * Groups the pull requests of active threads by what they need from the developer, newest link first. Closed ones
 * are left out, since nobody acts on them. Conflicts are known only from a watch snapshot, the one cheap source.
 */
export function pullRequestOverview(
  links: readonly PullRequestLink[],
  threads: Readonly<Record<string, Thread>>,
  pullRequests: Readonly<Record<string, Remote<PullRequest>>>,
): PullRequestOverview {
  const newest = new Map<string, PullRequestLink>()
  for (const link of [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const thread = threads[link.threadId]
    if (thread === undefined || thread.status === "archived" || newest.has(link.url)) continue
    newest.set(link.url, link)
  }

  const overview = { attention: [], open: [], merged: [] } as {
    [K in "attention" | "open" | "merged"]: OverviewPullRequest[]
  }
  for (const link of newest.values()) {
    const remote = pullRequests[link.url]
    const pullRequest = remote?.status === "ready" ? remote.value : null
    const snapshot = link.watch?.snapshot ?? null
    const status = pullRequest?.status ?? snapshot?.status
    if (status === "closed") continue
    const checks = pullRequest?.checks ?? snapshot?.checks ?? null
    const review = pullRequest?.review ?? snapshot?.review ?? null
    const needs =
      status === "merged"
        ? []
        : [
            checks === "failing" && "checks",
            review === "changesRequested" && "changes",
            snapshot?.mergeable === "conflicting" && "conflicts",
          ].filter((need): need is PullRequestNeed => need !== false)
    const row = {
      url: link.url,
      threadId: link.threadId,
      pullRequest,
      error: remote?.status === "error" ? remote.message : null,
      needs,
    }
    if (status === "merged") overview.merged.push(row)
    else if (needs.length > 0) overview.attention.push(row)
    else overview.open.push(row)
  }
  return { ...overview, urls: [...newest.keys()] }
}

const stateRank: Readonly<Record<string, number>> = { started: 0, unstarted: 1, triage: 2, backlog: 3 }
/** Linear's 0 means no priority, which sorts after low. */
const priorityRank = (priority: number) => (priority === 0 ? 5 : priority)

/**
 * Issues from every server once each, work in progress first, then by priority and the latest update. Two servers
 * with the same Linear account answer the same issues.
 */
export function sortIssues(issues: readonly LinearIssue[]): LinearIssue[] {
  const unique = new Map(issues.map((issue) => [issue.id, issue]))
  return [...unique.values()].sort(
    (a, b) =>
      (stateRank[a.state.type] ?? 4) - (stateRank[b.state.type] ?? 4) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.updatedAt.localeCompare(a.updatedAt),
  )
}

/** The draft a thread started from a ticket begins with. The agent reads the rest with its Linear tool. */
export const issueDraft = (issue: LinearIssue) => `${issue.identifier} ${issue.title}`
