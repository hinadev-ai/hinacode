import type { AgentEvent } from "./agent.ts"
import type { ChecksStatus, PullRequest, PullRequestStatus, ThreadStatus } from "./domain.ts"

/**
 * How the desktop sidebar and the phone's thread list draw a thread and its pull request. Icons are Remix names
 * and colors are tones, so each surface draws them with its own icon set and theme.
 */

/** How a thread's latest turn ended. */
export type Outcome = "completed" | "failed"

/** A usage limit already shows on the row as Limited, so only a finished or failed turn leaves a mark. */
export function outcomeOf(event: AgentEvent): Outcome | undefined {
  if (event.type === "turn_completed") return "completed"
  if (event.type === "turn_failed") return "failed"
  return undefined
}

/** Why an open pull request waits on the developer, most urgent first. Fixing a conflict reruns the checks anyway. */
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

/** The most urgent reason any of a thread's pull requests waits on the developer. Unloaded ones count as fine. */
export const pullRequestAttention = (
  pullRequests: ReadonlyArray<PullRequestState | undefined>,
): PullRequestAttention | undefined =>
  pullRequestAttentions.find((attention) =>
    pullRequests.some((pullRequest) => pullRequest !== undefined && needs(pullRequest, attention)),
  )

/**
 * What a row shows. A thread that is not idle shows its status. An idle one shows a result the developer has not
 * opened yet, then a pull request waiting on them, since opening the thread is usually how they act on either. A
 * finished turn with background tasks still running is not done, since the agent wakes up when they end, so it
 * reads as background work rather than a result. A failed turn still shows.
 */
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

/**
 * How loudly a row reads. A thread that needs the developer is at full contrast, a resting one a step down, and a
 * working one recedes to muted and faded until the developer reaches for it.
 */
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

/** Idle and archived rows show no icon. A thread that starts waiting for approval also rings a few times. */
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

/** A pull request's state as GitHub draws it. */
export const pullRequestIndicator = {
  draft: { icon: "RiGitPrDraftLine", tone: "muted" },
  open: { icon: "RiGitPullRequestLine", tone: "prOpen" },
  merged: { icon: "RiGitMergeLine", tone: "prMerged" },
  closed: { icon: "RiGitClosePullRequestLine", tone: "danger" },
} as const satisfies Record<PullRequestStatus, { icon: string; tone: IndicatorTone }>

/** Only failing checks need the developer, so only they get a color. Amber would claim pending checks need them. */
export const checksIndicator = {
  passing: { icon: "RiCheckboxCircleFill", tone: "muted" },
  failing: { icon: "RiCloseCircleFill", tone: "danger" },
  pending: { icon: "RiTimeLine", tone: "muted" },
} as const satisfies Record<ChecksStatus, { icon: string; tone: IndicatorTone }>

export const isOpen = (status: PullRequestStatus) => status === "open" || status === "draft"

/** The checks worth showing next to a pull request: none once it has merged or closed, since nobody acts on them. */
export const openChecks = (pullRequest: { status: PullRequestStatus; checks: ChecksStatus | null } | undefined) =>
  pullRequest !== undefined && isOpen(pullRequest.status) ? pullRequest.checks : null
