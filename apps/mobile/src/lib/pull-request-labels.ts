import type { ChecksStatus, PullRequestStatus, ReviewStatus } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import type { Tone } from "@/components/ui"
import type { Palette } from "@/constants/theme"
import { copy } from "@/lib/copy"
import type { PullRequestSummary } from "@/stores/pull-requests"

export const statusGlyph = (theme: Palette): Record<PullRequestStatus, { name: IconName; color: string }> => ({
  open: { name: "RiGitPullRequestLine", color: theme.running },
  draft: { name: "RiGitPrDraftLine", color: theme.textMuted },
  // `link` is the violet that reads in both themes, where `primary` is too dark on black.
  merged: { name: "RiGitMergeLine", color: theme.link },
  closed: { name: "RiGitClosePullRequestLine", color: theme.danger },
})

export const statusLabel = (status: PullRequestStatus) => copy(`mobile_pr_state_${status}`)
export const statusTone: Record<PullRequestStatus, Tone> = {
  open: "running",
  draft: "neutral",
  merged: "neutral",
  closed: "danger",
}

export const checksLabel = (checks: ChecksStatus) => copy(`mobile_pr_checks_${checks}`)
export const checksTone: Record<ChecksStatus, Tone> = { passing: "running", failing: "danger", pending: "attention" }
export const checksIcon: Record<ChecksStatus, IconName> = {
  passing: "RiCheckLine",
  failing: "RiErrorWarningLine",
  pending: "RiLoader4Line",
}

const reviewKeys = {
  approved: "mobile_pr_review_approved",
  changesRequested: "mobile_pr_review_changes_requested",
  reviewRequired: "mobile_pr_review_required",
} as const
export const reviewLabel = (review: ReviewStatus) => copy(reviewKeys[review])
export const reviewTone: Record<ReviewStatus, Tone> = {
  approved: "running",
  changesRequested: "attention",
  reviewRequired: "neutral",
}

export const checksDot = (theme: Palette, checks: ChecksStatus | null) =>
  checks === "failing" ? theme.danger : checks === "pending" ? theme.attention : null

/** "Pull request #123, Open, Checks failing" for screen readers. */
export function pullRequestLabel(number: string, summary: PullRequestSummary | null, more = 0) {
  const checks = summary?.checks ?? null
  return [
    copy("mobile_pr_number", { number }),
    summary !== null && statusLabel(summary.status),
    checks !== null && checksLabel(checks),
    more > 0 && copy("mobile_pr_more", { count: String(more) }),
  ]
    .filter((part) => typeof part === "string")
    .join(", ")
}

