import type { AgentEvent } from "@shared/agent.ts"
import type { ThreadStatus } from "@shared/domain.ts"

/** How a thread's latest turn ended. */
export type Outcome = "completed" | "failed"

/** What a row shows: the thread's status, or for an idle thread, a result the developer has not opened yet. */
export type RowState = ThreadStatus | `unseen_${Outcome}`

export const rowState = (status: ThreadStatus, unseen: Outcome | undefined): RowState =>
  status === "idle" && unseen !== undefined ? `unseen_${unseen}` : status

/**
 * How loudly a row reads, as on the desktop: a thread that needs the developer at full contrast, a resting one a
 * step down, and a working one muted.
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

/** A usage limit already shows on the row as Limited, so only a finished or failed turn leaves a mark. */
export function outcomeOf(event: AgentEvent): Outcome | undefined {
  if (event.type === "turn_completed") return "completed"
  if (event.type === "turn_failed") return "failed"
  return undefined
}
