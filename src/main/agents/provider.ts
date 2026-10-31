import type { AttachmentSource } from "../services/Attachments.ts"
import { type Effect, Schema, type Stream } from "effect"
import type { AccessMode, Attachment, ExternalSession, Message } from "../../shared/domain.ts"
import type { PlanLimits } from "../../shared/limits.ts"
import type {
  AccountHome,
  AgentAccount,
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  BackgroundTask,
  ContextBreakdown,
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

export interface Wake {
  readonly threadId: string
  readonly sessionId: string
  readonly events: Stream.Stream<AgentEvent, AgentError>
  readonly discard: Effect.Effect<void>
}

export interface BackgroundTasksChange {
  readonly threadId: string
  readonly tasks: ReadonlyArray<BackgroundTask>
}

export type NativeSession = Pick<ExternalSession, "sessionId" | "title" | "preview" | "branch" | "updatedAt">

export type ImportedMessage = Pick<Message, "role" | "parts" | "createdAt" | "completedAt" | "forkPoint"> & {
  readonly images?: ReadonlyArray<AttachmentSource>
}

export interface SessionHistory {
  readonly title: string | null
  readonly model: string | null
  readonly messages: ReadonlyArray<ImportedMessage> | null
}

export const LISTED_SESSIONS = 50

export interface AgentProvider {
  readonly id: ProviderId
  readonly listModels: Effect.Effect<ReadonlyArray<ModelInfo>, AgentError>
  readonly account: (home: AccountHome | null) => Effect.Effect<AgentAccount, AgentError>
  readonly planLimits: (home: AccountHome | null) => Effect.Effect<PlanLimits | null, AgentError>
  readonly usage: (sessionId: string, home: AccountHome | null) => Effect.Effect<ThreadUsage | null, AgentError>
  readonly copySession?: (
    sessionId: string,
    from: AccountHome | null,
    to: AccountHome | null,
  ) => Effect.Effect<void, AgentError>
  readonly listSessions?: (
    cwd: string,
    home: AccountHome | null,
  ) => Effect.Effect<ReadonlyArray<NativeSession>, AgentError>
  readonly readSession?: (
    sessionId: string,
    cwd: string,
    home: AccountHome | null,
  ) => Effect.Effect<SessionHistory, AgentError>
  readonly listCommands: (input: {
    readonly threadId: string
    readonly cwd: string
    readonly home: AccountHome | null
  }) => Effect.Effect<ReadonlyArray<AgentCommand>, AgentError>
  readonly runTurn: (input: RunTurnInput) => Stream.Stream<AgentEvent, AgentError>
  readonly wakes?: Stream.Stream<Wake>
  readonly steer: (
    threadId: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
  ) => Effect.Effect<void, AgentError>
  readonly interrupt: (threadId: string) => Effect.Effect<void>
  readonly closeSession?: (threadId: string, home: AccountHome | null) => Effect.Effect<void, AgentError>
  readonly backgroundTasks?: {
    readonly changes: Stream.Stream<BackgroundTasksChange>
    readonly stop: (threadId: string, taskId: string) => Effect.Effect<void, AgentError>
  }
  readonly contextBreakdown?: (threadId: string) => Effect.Effect<ContextBreakdown | null, AgentError>
  readonly stopSubagent?: (threadId: string, subagentId: string) => Effect.Effect<void, AgentError>
  readonly respondApproval: (requestId: string, decision: ApprovalDecision, note?: string) => Effect.Effect<boolean>
  readonly respondQuestion: (requestId: string, answers: QuestionAnswers) => Effect.Effect<void>
  readonly setAccessMode: (threadId: string, accessMode: AccessMode) => Effect.Effect<void, AgentError>
}
