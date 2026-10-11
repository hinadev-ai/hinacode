import { Effect, Schema, Stream } from "effect"
import type { Attachment } from "../../shared/domain.ts"
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
  /** Adds user input to the running turn; its output keeps flowing into that turn's stream. Fails when no turn is running. */
  readonly steer: (
    threadId: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
  ) => Effect.Effect<void, AgentError>
  readonly interrupt: (threadId: string) => Effect.Effect<void>
  readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
}
