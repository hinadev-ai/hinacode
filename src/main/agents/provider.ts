import { type Effect, Schema, type Stream } from "effect"
import type { AccessMode, Attachment } from "../../shared/domain.ts"
import type { PlanLimits } from "../../shared/limits.ts"
import type {
  AccountHome,
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

/** A turn the agent started by itself on a thread with no turn running. */
export interface Wake {
  readonly threadId: string
  /** Ends after turn_completed, turn_failed or turn_limited, like runTurn's stream. */
  readonly events: Stream.Stream<AgentEvent, AgentError>
  /** Stops this turn if the runner cannot adopt its stream. Safe after it has ended or been replaced. */
  readonly discard: Effect.Effect<void>
}

/**
 * One implementation per agent backend. The runner keeps one provider instance per process;
 * providers own their child processes and in-flight sessions keyed by threadId.
 */
export interface AgentProvider {
  readonly id: ProviderId
  readonly listModels: Effect.Effect<ReadonlyArray<ModelInfo>, AgentError>
  /**
   * Who the agent home `home` is signed in as, or the CLI's own login for null. Read fresh on each call, so
   * signing in or out in a terminal shows up without a restart.
   */
  readonly account: (home: AccountHome | null) => Effect.Effect<AgentAccount, AgentError>
  /** Plan allowance windows of the login in `home`. Null when it has none, such as with an API key. */
  readonly planLimits: (home: AccountHome | null) => Effect.Effect<PlanLimits | null, AgentError>
  /**
   * Tokens the session and every agent it started spent, read from the agent home `home` (the CLI's own for
   * null). Null when there is no transcript.
   */
  readonly usage: (sessionId: string, home: AccountHome | null) => Effect.Effect<ThreadUsage | null, AgentError>
  /** Commands and skills the agent would load for a thread working in `cwd` on the account in `home`. */
  readonly listCommands: (input: {
    readonly threadId: string
    readonly cwd: string
    readonly home: AccountHome | null
  }) => Effect.Effect<ReadonlyArray<AgentCommand>, AgentError>
  /** Streams events for one turn. Ends after turn_completed, turn_failed or turn_limited. */
  readonly runTurn: (input: RunTurnInput) => Stream.Stream<AgentEvent, AgentError>
  /**
   * Turns the agent starts by itself, such as Claude replying to a background task that finished after
   * the turn ended. A provider whose agent never does that leaves it out.
   */
  readonly wakes?: Stream.Stream<Wake>
  /** Adds user input to the running turn; its output keeps flowing into that turn's stream. Fails when no turn is running. */
  readonly steer: (
    threadId: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
  ) => Effect.Effect<void, AgentError>
  readonly interrupt: (threadId: string) => Effect.Effect<void>
  /** Stops one sub-agent of the thread by its `Subagent.id`. A provider that cannot leaves it out. */
  readonly stopSubagent?: (threadId: string, subagentId: string) => Effect.Effect<void, AgentError>
  readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
  readonly respondQuestion: (requestId: string, answers: QuestionAnswers) => Effect.Effect<void>
  /** Applies a new access mode to a live session. Providers without one pick it up on the next turn. */
  readonly setAccessMode: (threadId: string, accessMode: AccessMode) => Effect.Effect<void, AgentError>
}
