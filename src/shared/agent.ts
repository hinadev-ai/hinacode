import { Schema } from "effect"
import type { AccessMode, Attachment } from "./domain.ts"
import { PlanLimits, UsageLimit } from "./limits.ts"

export const ProviderId = Schema.Literals(["claude", "codex", "muse", "cursor", "opencode"])
export type ProviderId = typeof ProviderId.Type

export const AccountProviderId = Schema.Literals(["claude", "codex"])
export type AccountProviderId = typeof AccountProviderId.Type

export const UpdatableProviderId = Schema.Literals(["claude", "codex"])
export type UpdatableProviderId = typeof UpdatableProviderId.Type

export const AgentUpdate = Schema.Struct({
  provider: UpdatableProviderId,
  current: Schema.String,
  latest: Schema.String,
})
export type AgentUpdate = typeof AgentUpdate.Type

export const ModelInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  provider: ProviderId,
  efforts: Schema.Array(Schema.String),
  defaultEffort: Schema.NullOr(Schema.String),
  fastMode: Schema.Boolean,
  autoMode: Schema.Boolean,
})
export type ModelInfo = typeof ModelInfo.Type

export const InstalledAgent = Schema.Struct({ provider: ProviderId, installed: Schema.Boolean })
export type InstalledAgent = typeof InstalledAgent.Type

export const AgentAccount = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscription"),
    email: Schema.NullOr(Schema.String),
    plan: Schema.NullOr(Schema.String),
    organization: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("apiKey") }),
  Schema.Struct({ type: Schema.Literal("external"), service: Schema.String }),
  Schema.Struct({ type: Schema.Literal("signedOut") }),
])
export type AgentAccount = typeof AgentAccount.Type

export const AgentProfile = Schema.Struct({
  id: Schema.String,
  provider: AccountProviderId,
  name: Schema.String,
  configDir: Schema.String,
  binary: Schema.String,
})
export type AgentProfile = typeof AgentProfile.Type

export const AgentProfileName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80))
export const AgentConfigDir = Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^(~(\/|$)|\/)/))
export const AgentBinary = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())

export interface AccountHome {
  readonly dir: string
  readonly binary: string
}

export const CLAUDE_EFFORT_LEVELS: ReadonlyArray<string> = ["low", "medium", "high", "xhigh", "max"]

export const unlistedModel = (id: string, provider: ProviderId): ModelInfo => ({
  id,
  label: id,
  provider,
  efforts: [],
  defaultEffort: null,
  fastMode: false,
  autoMode: false,
})

export const presetModels = (
  listed: ReadonlyArray<ModelInfo>,
  preset: ReadonlyArray<string>,
  keep: string | null,
): ReadonlyArray<ModelInfo> => {
  const picked = listed.filter((model) => preset.includes(model.id) || model.id === keep)
  return preset.length === 0 || !picked.some((model) => model.id !== keep) ? listed : picked
}

export const AgentCommand = Schema.Struct({
  trigger: Schema.Literals(["/", "$"]),
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.String,
  builtin: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Literals(["user", "project"])),
})
export type AgentCommand = typeof AgentCommand.Type

export const ApprovalKind = Schema.Literals(["tool", "command", "patch"])
export type ApprovalKind = typeof ApprovalKind.Type

export const SessionScope = Schema.Struct({
  tool: Schema.String,
  kind: Schema.Literals(["command", "path", "domain", "tool"]),
  value: Schema.String,
})
export type SessionScope = typeof SessionScope.Type

export const ApprovalRequest = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  provider: ProviderId,
  kind: ApprovalKind,
  title: Schema.String,
  detail: Schema.String,
  input: Schema.optional(Schema.Unknown),
  sessionScope: Schema.optional(SessionScope),
})
export type ApprovalRequest = typeof ApprovalRequest.Type

export const ApprovalDecision = Schema.Literals(["allow", "allow_for_session", "deny"])
export type ApprovalDecision = typeof ApprovalDecision.Type

export const QuestionOption = Schema.Struct({ label: Schema.String, description: Schema.String })
export type QuestionOption = typeof QuestionOption.Type

export const Question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(QuestionOption),
  multiSelect: Schema.Boolean,
  allowsText: Schema.Boolean,
  secret: Schema.Boolean,
})
export type Question = typeof Question.Type

export const QuestionRequest = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  provider: ProviderId,
  questions: Schema.Array(Question),
})
export type QuestionRequest = typeof QuestionRequest.Type

export const QuestionAnswers = Schema.Record(Schema.String, Schema.Array(Schema.String))
export type QuestionAnswers = typeof QuestionAnswers.Type

export const SecretRequest = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  name: Schema.String,
  description: Schema.String,
})
export type SecretRequest = typeof SecretRequest.Type

export const ContextWindow = Schema.Struct({ usedTokens: Schema.Number, maxTokens: Schema.Number })
export type ContextWindow = typeof ContextWindow.Type

export const ContextBreakdown = Schema.Struct({
  usedTokens: Schema.Number,
  maxTokens: Schema.Number,
  categories: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      tokens: Schema.Number,
      kind: Schema.Literals(["used", "free", "buffer"]),
    }),
  ),
})
export type ContextBreakdown = typeof ContextBreakdown.Type

export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.optional(Schema.Number),
  context: Schema.optional(ContextWindow),
})
export type TokenUsage = typeof TokenUsage.Type

export const ModelUsage = Schema.Struct({
  model: Schema.String,
  inputTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  outputTokens: Schema.Number,
})
export type ModelUsage = typeof ModelUsage.Type

export const ThreadUsage = Schema.Struct({
  models: Schema.Array(ModelUsage),
  transcripts: Schema.Number,
})
export type ThreadUsage = typeof ThreadUsage.Type

export const AccountLimits = Schema.Struct({
  provider: ProviderId,
  accountId: Schema.NullOr(Schema.String),
  limits: Schema.NullOr(PlanLimits),
})
export type AccountLimits = typeof AccountLimits.Type

export const SubagentStatus = Schema.Literals(["running", "completed", "failed", "stopped"])
export type SubagentStatus = typeof SubagentStatus.Type

export const Subagent = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  callId: Schema.NullOr(Schema.String),
  status: SubagentStatus,
  summary: Schema.NullOr(Schema.String),
  lastTool: Schema.NullOr(Schema.String),
  toolUses: Schema.NullOr(Schema.Number),
  tokens: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
})
export type Subagent = typeof Subagent.Type

export const BackgroundTaskKind = Schema.Literals(["shell", "workflow", "wakeup", "other"])
export type BackgroundTaskKind = typeof BackgroundTaskKind.Type

export const BackgroundTask = Schema.Struct({
  id: Schema.String,
  kind: BackgroundTaskKind,
  label: Schema.String,
  startedAt: Schema.String,
  firesAt: Schema.optional(Schema.String),
})
export type BackgroundTask = typeof BackgroundTask.Type

export const Compaction = Schema.Union([
  Schema.Struct({ status: Schema.Literal("running") }),
  Schema.Struct({
    status: Schema.Literal("done"),
    trigger: Schema.Literals(["manual", "auto"]),
    preTokens: Schema.NullOr(Schema.Number),
    postTokens: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.NullOr(Schema.String) }),
])
export type Compaction = typeof Compaction.Type

export const ForkPoint = Schema.Struct({
  sessionId: Schema.String,
  checkpoint: Schema.String,
  owner: Schema.optional(Schema.Struct({ provider: ProviderId, accountId: Schema.NullOr(Schema.String) })),
})
export type ForkPoint = typeof ForkPoint.Type

export const AgentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session_bound"), providerSessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning_delta"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_call_started"),
    callId: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
    parentCallId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_finished"),
    callId: Schema.String,
    output: Schema.Unknown,
    fullOutputBytes: Schema.optional(Schema.Number),
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("file_changed"),
    path: Schema.String,
    diff: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("approval_requested"), request: ApprovalRequest }),
  Schema.Struct({ type: Schema.Literal("approval_resolved"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("question_requested"), request: QuestionRequest }),
  Schema.Struct({ type: Schema.Literal("question_resolved"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("questions_posted"), text: Schema.String, questions: Schema.Array(Question) }),
  Schema.Struct({ type: Schema.Literal("subagent_updated"), subagent: Subagent }),
  Schema.Struct({ type: Schema.Literal("compaction_updated"), compaction: Compaction }),
  Schema.Struct({ type: Schema.Literal("secret_requested"), request: SecretRequest }),
  Schema.Struct({ type: Schema.Literal("secret_resolved"), requestId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("turn_completed"),
    usage: Schema.optional(TokenUsage),
    forkPoint: Schema.optional(ForkPoint),
  }),
  Schema.Struct({ type: Schema.Literal("turn_failed"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("turn_limited"), limit: UsageLimit }),
])
export type AgentEvent = typeof AgentEvent.Type

export interface RunTurnInput {
  readonly threadId: string
  readonly prompt: string
  readonly attachments: ReadonlyArray<Attachment>
  readonly cwd: string
  readonly model: string
  readonly effort: string | null
  readonly fastMode: boolean
  readonly autoCompactTokens: number | null
  readonly userSkills: boolean
  readonly accessMode: AccessMode
  readonly resumeSessionId: string | null
  readonly forkAt: string | null
  readonly home: AccountHome | null
  readonly mcpServer: McpConnection
  readonly instructions: string
}

export interface McpConnection {
  readonly url: string
  readonly headers: { readonly authorization: string }
}
