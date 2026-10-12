import { Schema } from "effect"
import type { Attachment } from "./domain.ts"

export const ProviderId = Schema.Literals(["claude", "codex"])
export type ProviderId = typeof ProviderId.Type

export const ModelInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  provider: ProviderId,
  /** Reasoning efforts the model accepts, lowest first. Empty when it has no effort control. */
  efforts: Schema.Array(Schema.String),
  /** The effort used when a thread sets none, or null when the agent does not say. */
  defaultEffort: Schema.NullOr(Schema.String),
  /** Whether the model offers a faster, pricier service tier. */
  fastMode: Schema.Boolean,
})
export type ModelInfo = typeof ModelInfo.Type

/** A model the agent no longer lists, such as a thread's saved model or a typed id. */
export const unlistedModel = (id: string, provider: ProviderId): ModelInfo => ({
  id,
  label: id,
  provider,
  efforts: [],
  defaultEffort: null,
  fastMode: false,
})

/**
 * Something the composer can complete: a Claude slash command or skill typed as `/name`, or a Codex
 * skill typed as `$name`.
 */
export const AgentCommand = Schema.Struct({
  trigger: Schema.Literals(["/", "$"]),
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.String,
})
export type AgentCommand = typeof AgentCommand.Type

export const ApprovalKind = Schema.Literals(["tool", "command", "patch"])
export type ApprovalKind = typeof ApprovalKind.Type

/**
 * What "Allow for session" approves: later calls of `tool` with this exact command, this exact path,
 * any URL on this domain, or (`kind: "tool"`) every call of the tool.
 */
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

export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.optional(Schema.Number),
})
export type TokenUsage = typeof TokenUsage.Type

export const AgentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session_bound"), providerSessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning_delta"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_call_started"),
    callId: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_finished"),
    callId: Schema.String,
    output: Schema.Unknown,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("file_changed"),
    path: Schema.String,
    diff: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("approval_requested"), request: ApprovalRequest }),
  Schema.Struct({ type: Schema.Literal("approval_resolved"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("turn_completed"), usage: Schema.optional(TokenUsage) }),
  Schema.Struct({ type: Schema.Literal("turn_failed"), message: Schema.String }),
])
export type AgentEvent = typeof AgentEvent.Type

export interface RunTurnInput {
  readonly threadId: string
  readonly prompt: string
  readonly attachments: ReadonlyArray<Attachment>
  readonly cwd: string
  readonly model: string
  /** Null leaves the model's default effort. */
  readonly effort: string | null
  readonly fastMode: boolean
  /** Provider session or thread id from a previous turn, for resume. */
  readonly resumeSessionId: string | null
  /** The built-in kkcode MCP server, authenticated as this thread. */
  readonly mcpServer: McpConnection
}

/** A Streamable HTTP MCP endpoint plus the headers that authenticate the caller. */
export interface McpConnection {
  readonly url: string
  readonly headers: { readonly authorization: string }
}
