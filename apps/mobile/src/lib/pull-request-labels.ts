import type { ChecksStatus, PullRequestStatus, ReviewStatus } from "@shared/domain.ts"
import { pullRequestIndicator } from "@shared/threadStatus.ts"
import type { IconName } from "@/components/icon"
import type { Tone } from "@/components/ui"
import { indicatorGlyph, type Palette } from "@/constants/theme"
import { copy } from "@/lib/copy"
import type { PullRequestSummary } from "@/stores/pull-requests"

export const statusGlyph = (theme: Palette): Record<PullRequestStatus, { name: IconName; color: string }> => ({
  open: indicatorGlyph(theme, pullRequestIndicator.open),
  draft: indicatorGlyph(theme, pullRequestIndicator.draft),
  merged: indicatorGlyph(theme, pullRequestIndicator.merged),
  closed: indicatorGlyph(theme, pullRequestIndicator.closed),
})

export const statusLabel = (status: PullRequestStatus) => copy(`mobile_pr_state_${status}`)

export const checksLabel = (checks: ChecksStatus) => copy(`mobile_pr_checks_${checks}`)
export const checksTone: Record<ChecksStatus, Tone> = { passing: "neutral", failing: "danger", pending: "neutral" }
export const checksIcon: Record<ChecksStatus, IconName> = {
  passing: "Check",
  failing: "Warning",
  pending: "Spinner",
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

export function pullRequestLabel(number: string, summary: PullRequestSummary | null) {
  const checks = summary?.checks ?? null
  return [
    copy("mobile_pr_number", { number }),
    summary !== null && statusLabel(summary.status),
    checks !== null && checksLabel(checks),
  ]
    .filter((part) => typeof part === "string")
    .join(", ")
}

