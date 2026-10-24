import type { AgentEvent } from "./agent.ts"
import type { ChecksStatus, PullRequestStatus, ThreadStatus } from "./domain.ts"

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

/** What a row shows: the thread's status, or for an idle thread, a result the developer has not opened yet. */
export type RowState = ThreadStatus | `unseen_${Outcome}`

export const rowState = (status: ThreadStatus, unseen: Outcome | undefined): RowState =>
  status === "idle" && unseen !== undefined ? `unseen_${unseen}` : status

/**
 * How loudly a row reads. A thread that needs the developer is at full contrast, a resting one a step down, and a
 * working one recedes to muted and faded until the developer reaches for it.
 */
export const rowEmphasis = {
  awaiting_approval: "attention",
  limited: "attention",
  unseen_completed: "attention",
  unseen_failed: "attention",
  idle: "resting",
  archived: "resting",
  running: "working",
} as const satisfies Record<RowState, "attention" | "resting" | "working">

export type IndicatorTone = "muted" | "attention" | "success" | "danger" | "prOpen" | "prMerged"

/** Idle and archived rows show no icon. A thread that starts waiting for approval also rings a few times. */
export const rowStatusIndicator = {
  running: { icon: "RiPulseLine", tone: "muted" },
  awaiting_approval: { icon: "RiQuestionFill", tone: "attention" },
  limited: { icon: "RiHourglassFill", tone: "attention" },
  unseen_completed: { icon: "RiCheckboxCircleFill", tone: "success" },
  unseen_failed: { icon: "RiErrorWarningFill", tone: "danger" },
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
