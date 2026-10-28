import type { LinearIssue } from "./domain.ts"

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
