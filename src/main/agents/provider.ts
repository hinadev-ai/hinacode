import { Effect, Schema, Stream } from "effect"
import type { AccessMode, Attachment } from "../../shared/domain.ts"
import type { PlanLimits } from "../../shared/limits.ts"
import type {
  AgentAccount,
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ModelInfo,
  ProviderId,
  QuestionAnswers,
  RunTurnInput,
  ThreadUsage,
} from "../../shared/agent.ts"

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
  /** Read fresh on each call, so signing in or out in a terminal shows up without a restart. */
  readonly account: Effect.Effect<AgentAccount, AgentError>
  /** The signed-in account's plan allowance windows. Null when it has none, such as with an API key. */
  readonly planLimits: Effect.Effect<PlanLimits | null, AgentError>
  /** Tokens the session and every agent it started spent, read from disk. Null when there is no transcript. */
  readonly usage: (sessionId: string) => Effect.Effect<ThreadUsage | null, AgentError>
  /** Commands and skills the agent would load for a thread working in `cwd`. */
  readonly listCommands: (input: {
    readonly threadId: string
    readonly cwd: string
  }) => Effect.Effect<ReadonlyArray<AgentCommand>, AgentError>
  /** Streams events for one turn. Ends after turn_completed, turn_failed or turn_limited. */
  readonly runTurn: (input: RunTurnInput) => Stream.Stream<AgentEvent, AgentError>
  /** Adds user input to the running turn; its output keeps flowing into that turn's stream. Fails when no turn is running. */
  readonly steer: (
    threadId: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
  ) => Effect.Effect<void, AgentError>
  readonly interrupt: (threadId: string) => Effect.Effect<void>
  readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
  readonly respondQuestion: (requestId: string, answers: QuestionAnswers) => Effect.Effect<void>
  /** Applies a new access mode to a live session. Providers without one pick it up on the next turn. */
  readonly setAccessMode: (threadId: string, accessMode: AccessMode) => Effect.Effect<void, AgentError>
}
