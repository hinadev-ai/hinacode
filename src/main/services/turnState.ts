import type { AgentEvent } from "../../shared/agent.ts"
import type { ThreadStatus } from "../../shared/domain.ts"
import type { UsageLimit } from "../../shared/limits.ts"

export interface TurnState {
  readonly status: ThreadStatus
  readonly outcome: "completed" | "failed" | null
  readonly resumedSessionId: string | null
}

export type TurnEffect =
  | { readonly type: "bind_session"; readonly providerSessionId: string }
  | { readonly type: "drop_session" }
  | { readonly type: "set_status"; readonly status: ThreadStatus; readonly usageLimit?: UsageLimit }
  | { readonly type: "steer_held" }

export interface TurnInputs {
  readonly waitsOnUser: boolean
}

export const initialTurnState = (resumedSessionId: string | null): TurnState => ({
  status: "running",
  outcome: null,
  resumedSessionId,
})

const statusAfter = (event: AgentEvent, { waitsOnUser }: TurnInputs): ThreadStatus | undefined => {
  switch (event.type) {
    case "approval_requested":
    case "question_requested":
    case "secret_requested":
      return "awaiting_approval"
    case "approval_resolved":
    case "question_resolved":
    case "secret_resolved":
      return waitsOnUser ? "awaiting_approval" : "running"
    case "turn_completed":
    case "turn_failed":
      return "idle"
    case "turn_limited":
      return "limited"
    default:
      return undefined
  }
}

const outcomeAfter = (event: AgentEvent, outcome: TurnState["outcome"]): TurnState["outcome"] => {
  if (event.type === "turn_completed") return "completed"
  if (event.type === "turn_failed") return "failed"
  return outcome
}

const sessionEffects = (state: TurnState, event: AgentEvent): ReadonlyArray<TurnEffect> => {
  if (event.type === "session_bound" && event.providerSessionId !== state.resumedSessionId) {
    return [{ type: "bind_session", providerSessionId: event.providerSessionId }]
  }
  if (event.type === "turn_failed" && event.sessionLost) return [{ type: "drop_session" }]
  return []
}

const releasesUser = (event: AgentEvent) =>
  event.type === "approval_resolved" || event.type === "question_resolved" || event.type === "secret_resolved"

export const step = (
  state: TurnState,
  event: AgentEvent,
  inputs: TurnInputs,
): readonly [TurnState, ReadonlyArray<TurnEffect>] => {
  const next = statusAfter(event, inputs)
  const status = next ?? state.status
  const statusEffects: ReadonlyArray<TurnEffect> =
    next === undefined || next === state.status
      ? []
      : [{ type: "set_status", status, ...(event.type === "turn_limited" && { usageLimit: event.limit }) }]
  return [
    { ...state, status, outcome: outcomeAfter(event, state.outcome) },
    [
      ...sessionEffects(state, event),
      ...statusEffects,
      ...(releasesUser(event) ? [{ type: "steer_held" as const }] : []),
    ],
  ]
}
