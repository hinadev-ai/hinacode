import { Effect, Schema, Stream } from "effect"
import type { AgentEvent, ApprovalDecision, ModelInfo, ProviderId, RunTurnInput } from "../../shared/agent.ts"

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  provider: Schema.String,
  message: Schema.String,
}) {}

/**
 * One implementation per agent backend. The runner keeps one provider instance per process;
 * providers own their child processes and in-flight sessions keyed by threadId.
 */
export interface AgentProvider {
  readonly id: ProviderId
  readonly listModels: Effect.Effect<ReadonlyArray<ModelInfo>, AgentError>
  /** Streams events for one turn. Ends after turn_completed or turn_failed. */
  readonly runTurn: (input: RunTurnInput) => Stream.Stream<AgentEvent, AgentError>
  readonly interrupt: (threadId: string) => Effect.Effect<void>
  readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
}
