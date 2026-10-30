import type { AgentEvent } from "./agent.ts"
import type { ChecksStatus, PullRequest, PullRequestStatus, ThreadStatus } from "./domain.ts"

export type Outcome = "completed" | "failed"

export function outcomeOf(event: AgentEvent): Outcome | undefined {
  if (event.type === "turn_completed") return "completed"
  if (event.type === "turn_failed") return "failed"
  return undefined
}

const pullRequestAttentions = ["conflicting", "checksFailing", "changesRequested"] as const
export type PullRequestAttention = (typeof pullRequestAttentions)[number]

type PullRequestState = Pick<PullRequest, "status" | "checks" | "review" | "mergeable">

const needs = (pullRequest: PullRequestState, attention: PullRequestAttention) => {
  if (!isOpen(pullRequest.status)) return false
  switch (attention) {
    case "conflicting":
      return pullRequest.mergeable === "conflicting"
    case "checksFailing":
      return pullRequest.checks === "failing"
    case "changesRequested":
      return pullRequest.review === "changesRequested"
  }
}

export const pullRequestAttention = (
  pullRequests: ReadonlyArray<PullRequestState | undefined>,
): PullRequestAttention | undefined =>
  pullRequestAttentions.find((attention) =>
    pullRequests.some((pullRequest) => pullRequest !== undefined && needs(pullRequest, attention)),
  )

export type RowState = ThreadStatus | "background" | `unseen_${Outcome}` | `pr_${PullRequestAttention}`

export const rowState = (
  status: ThreadStatus,
  background: boolean,
  unseen: Outcome | undefined,
  pullRequest: PullRequestAttention | undefined,
): RowState => {
  if (status !== "idle") return status
  if (unseen === "failed") return "unseen_failed"
  if (background) return "background"
  if (unseen !== undefined) return `unseen_${unseen}`
  return pullRequest === undefined ? status : `pr_${pullRequest}`
}

export const rowEmphasis = {
  awaiting_approval: "attention",
  limited: "attention",
  unseen_completed: "attention",
  unseen_failed: "attention",
  pr_conflicting: "attention",
  pr_checksFailing: "attention",
  pr_changesRequested: "attention",
  idle: "resting",
  archived: "resting",
  running: "working",
  background: "working",
} as const satisfies Record<RowState, "attention" | "resting" | "working">

export const needsAttention = (state: RowState) => rowEmphasis[state] === "attention"

export type IndicatorTone = "muted" | "attention" | "success" | "danger" | "prOpen" | "prMerged"

export const rowStatusIndicator = {
  running: { icon: "RiPulseLine", tone: "muted" },
  background: { icon: "RiTimeLine", tone: "muted" },
  awaiting_approval: { icon: "RiQuestionFill", tone: "attention" },
  limited: { icon: "RiHourglassFill", tone: "attention" },
  unseen_completed: { icon: "RiCheckboxCircleFill", tone: "success" },
  unseen_failed: { icon: "RiErrorWarningFill", tone: "danger" },
  pr_conflicting: { icon: "RiGitMergeFill", tone: "attention" },
  pr_checksFailing: { icon: "RiCloseCircleFill", tone: "danger" },
  pr_changesRequested: { icon: "RiFeedbackFill", tone: "attention" },
} as const satisfies Partial<Record<RowState, { icon: string; tone: IndicatorTone }>>

export const pullRequestIndicator = {
  draft: { icon: "RiGitPrDraftLine", tone: "muted" },
  open: { icon: "RiGitPullRequestLine", tone: "prOpen" },
  merged: { icon: "RiGitMergeLine", tone: "prMerged" },
  closed: { icon: "RiGitClosePullRequestLine", tone: "danger" },
} as const satisfies Record<PullRequestStatus, { icon: string; tone: IndicatorTone }>

export const checksIndicator = {
  passing: { icon: "RiCheckboxCircleFill", tone: "muted" },
  failing: { icon: "RiCloseCircleFill", tone: "danger" },
  pending: { icon: "RiTimeLine", tone: "muted" },
} as const satisfies Record<ChecksStatus, { icon: string; tone: IndicatorTone }>

export const isOpen = (status: PullRequestStatus) => status === "open" || status === "draft"

export const openChecks = (pullRequest: { status: PullRequestStatus; checks: ChecksStatus | null } | undefined) =>
  pullRequest !== undefined && isOpen(pullRequest.status) ? pullRequest.checks : null
