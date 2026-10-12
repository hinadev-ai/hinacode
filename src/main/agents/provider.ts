import { Effect, Schema, type Scope, Stream } from "effect"
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

/** A sign-in waiting for the user in the browser. */
export interface SignIn {
  readonly url: string
  /** The agent opened `url` itself. */
  readonly openedBrowser: boolean
  /**
   * Hands the agent the code its sign-in page shows when the browser cannot reach it directly. Null when
   * the agent never asks for one.
   */
  readonly submitCode: ((code: string) => Effect.Effect<void>) | null
  /** Succeeds once the home holds the new login. */
  readonly completed: Effect.Effect<void, AgentError>
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
  readonly account: (home: string | null) => Effect.Effect<AgentAccount, AgentError>
  /** Starts a subscription sign-in for the agent home `home`. Closing the scope abandons it. */
  readonly signIn: (home: string) => Effect.Effect<SignIn, AgentError, Scope.Scope>
  readonly signOut: (home: string) => Effect.Effect<void, AgentError>
  /** The signed-in account's plan allowance windows. Null when it has none, such as with an API key. */
  readonly planLimits: Effect.Effect<PlanLimits | null, AgentError>
  /** Tokens the session and every agent it started spent, read from disk. Null when there is no transcript. */
  readonly usage: (sessionId: string) => Effect.Effect<ThreadUsage | null, AgentError>
  /** Commands and skills the agent would load for a thread working in `cwd` on the account in `home`. */
  readonly listCommands: (input: {
    readonly threadId: string
    readonly cwd: string
    readonly home: string | null
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
