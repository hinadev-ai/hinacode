import type { Changes, ChecksStatus, Mergeable, PullRequestStatus, ReviewStatus, ThreadStatus } from "./domain.ts"
import { lineCounts } from "./patch.ts"

export type ShipVerdict = "ready" | "blocked" | "pending" | "working" | "empty"

export type ShipReportReason =
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

export interface ShipReportPullRequest {
  readonly url: string
  readonly number: number
  readonly title: string
  readonly status: PullRequestStatus
  readonly checks: ChecksStatus | null
  readonly review: ReviewStatus | null
  readonly mergeable: Mergeable
}

export interface ShipReport {
  readonly verdict: ShipVerdict
  readonly reasons: ReadonlyArray<ShipReportReason>
  readonly files: Changes["files"]
  readonly added: number
  readonly removed: number
  readonly pullRequests: ReadonlyArray<ShipReportPullRequest>
  readonly changesUnavailable: boolean
  readonly unresolvedPullRequests: number
}

export interface ShipReportInput {
  readonly threadStatus: ThreadStatus
  readonly changes: Changes | null
  readonly pullRequests: ReadonlyArray<ShipReportPullRequest>
  readonly changesUnavailable?: boolean
  readonly unresolvedPullRequests?: number
}

const verdictLabels: Record<ShipVerdict, string> = {
  ready: "Ready",
  blocked: "Blocked",
  pending: "Pending",
  working: "Working",
  empty: "No changes",
}

const reasonLabels: Record<ShipReportReason, string> = {
  checksFailing: "Checks are failing",
  conflicting: "A pull request conflicts with its base",
  changesRequested: "Changes were requested",
  checksPending: "Checks are still running",
  reviewRequired: "A review is still required",
  pullRequestUnknown: "A pull request is still loading",
  changesUnknown: "Changes were not loaded",
  threadRunning: "The agent is still running",
  awaitingApproval: "Waiting for approval",
  noPullRequest: "No pull request yet",
}

export const deriveShipReport = (input: ShipReportInput): ShipReport => {
  const files = input.changes?.files ?? []
  const { added, removed } = input.changes === null ? { added: 0, removed: 0 } : lineCounts(input.changes.patch)
  const active = input.pullRequests.filter(
    (pullRequest) => pullRequest.status === "open" || pullRequest.status === "draft",
  )
  const checksFailing = active.some((pullRequest) => pullRequest.checks === "failing")
  const conflicting = active.some((pullRequest) => pullRequest.mergeable === "conflicting")
  const changesRequested = active.some((pullRequest) => pullRequest.review === "changesRequested")
  const checksPending = active.some((pullRequest) => pullRequest.checks === "pending")
  const reviewRequired = active.some((pullRequest) => pullRequest.review === "reviewRequired")
  const threadRunning = input.threadStatus === "running"
  const awaitingApproval = input.threadStatus === "awaiting_approval"
  const changesUnavailable = input.changesUnavailable ?? false
  const unresolvedPullRequests = input.unresolvedPullRequests ?? 0
  const pullRequestUnknown = unresolvedPullRequests > 0

  let verdict: ShipVerdict
  if (checksFailing || conflicting || changesRequested) verdict = "blocked"
  else if (threadRunning || awaitingApproval) verdict = "working"
  else if (checksPending || reviewRequired || pullRequestUnknown || changesUnavailable) verdict = "pending"
  else if (files.length === 0 && input.pullRequests.length === 0) verdict = "empty"
  else verdict = "ready"

  const reasons: Array<ShipReportReason> = []
  if (checksFailing) reasons.push("checksFailing")
  if (conflicting) reasons.push("conflicting")
  if (changesRequested) reasons.push("changesRequested")
  if (checksPending) reasons.push("checksPending")
  if (reviewRequired) reasons.push("reviewRequired")
  if (pullRequestUnknown) reasons.push("pullRequestUnknown")
  if (changesUnavailable) reasons.push("changesUnknown")
  if (threadRunning) reasons.push("threadRunning")
  if (awaitingApproval) reasons.push("awaitingApproval")
  if (files.length > 0 && input.pullRequests.length === 0 && !pullRequestUnknown && verdict !== "empty")
    reasons.push("noPullRequest")

  return {
    verdict,
    reasons,
    files,
    added,
    removed,
    pullRequests: input.pullRequests,
    changesUnavailable,
    unresolvedPullRequests,
  }
}

export const shipReportMarkdown = (report: ShipReport, title: string): string => {
  const lines: Array<string> = [`## Ship report: ${title}`, "", `Verdict: ${verdictLabels[report.verdict]}`]
  for (const reason of report.reasons) lines.push(`- ${reasonLabels[reason]}`)
  lines.push("", "### Changes", "")
  if (report.changesUnavailable) lines.push("Changes were not loaded")
  else {
    lines.push(
      `${report.files.length} ${report.files.length === 1 ? "file" : "files"}, +${report.added} -${report.removed}`,
    )
    for (const file of report.files) lines.push(`- ${file.path} (${file.status})`)
  }
  if (report.pullRequests.length > 0 || report.unresolvedPullRequests > 0) {
    lines.push("", "### Pull requests", "")
    for (const pullRequest of report.pullRequests) {
      const checks = pullRequest.checks === null ? "" : `, checks ${pullRequest.checks}`
      const review = pullRequest.review === null ? "" : `, review ${pullRequest.review}`
      lines.push(
        `- #${pullRequest.number} ${pullRequest.title} (${pullRequest.url}): ${pullRequest.status}${checks}${review}`,
      )
    }
    if (report.unresolvedPullRequests > 0)
      lines.push(
        `- ${report.unresolvedPullRequests} ${report.unresolvedPullRequests === 1 ? "pull request was" : "pull requests were"} still loading`,
      )
  }
  return lines.join("\n")
}
