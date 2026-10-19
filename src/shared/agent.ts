import { Schema } from "effect"
import type { AccessMode, Attachment } from "./domain.ts"
import { PlanLimits, UsageLimit } from "./limits.ts"

export const ProviderId = Schema.Literals(["claude", "codex", "muse"])
export type ProviderId = typeof ProviderId.Type

/**
 * The agents an account can be added for. An added account is a home directory the agent reads its login
 * from, and Muse Code has no such directory: its login sits under `XDG_CONFIG_HOME`, which the commands it
 * runs also read.
 */
export const AccountProviderId = Schema.Literals(["claude", "codex"])
export type AccountProviderId = typeof AccountProviderId.Type

/** The agents whose CLI hinacode checks for a newer release: each publishes on npm and has an `update` command. */
export const UpdatableProviderId = Schema.Literals(["claude", "codex"])
export type UpdatableProviderId = typeof UpdatableProviderId.Type

/** A newer release of the agent CLI on PATH than the one installed. */
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
  /** Reasoning efforts the model accepts, lowest first. Empty when it has no effort control. */
  efforts: Schema.Array(Schema.String),
  /** The effort used when a thread sets none, or null when the agent does not say. */
  defaultEffort: Schema.NullOr(Schema.String),
  /** Whether the model offers a faster, pricier service tier. */
  fastMode: Schema.Boolean,
  /** Whether the agent can judge each action itself in the `auto` access mode, instead of only accepting edits. */
  autoMode: Schema.Boolean,
})
export type ModelInfo = typeof ModelInfo.Type

/** Who the agent's CLI is signed in as, which decides what its turns bill to. */
export const AgentAccount = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscription"),
    email: Schema.NullOr(Schema.String),
    /** Display name of the plan, such as "Claude Max" or "ChatGPT Plus". */
    plan: Schema.NullOr(Schema.String),
    organization: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("apiKey") }),
  /** A cloud provider's credentials, such as Amazon Bedrock or Google Vertex AI. */
  Schema.Struct({ type: Schema.Literal("external"), service: Schema.String }),
  Schema.Struct({ type: Schema.Literal("signedOut") }),
])
export type AgentAccount = typeof AgentAccount.Type

/** An account added in hinacode: a separate agent home with its own login and transcripts. */
export const AgentProfile = Schema.Struct({
  id: Schema.String,
  provider: AccountProviderId,
  name: Schema.String,
  /** The agent home (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`), an absolute path. */
  configDir: Schema.String,
  /** The CLI run against `configDir`, a path or a name looked up on PATH. */
  binary: Schema.String,
})
export type AgentProfile = typeof AgentProfile.Type

export const AgentProfileName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80))
/** Absolute, or relative to the user's home with a leading `~`. */
export const AgentConfigDir = Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^(~(\/|$)|\/)/))
export const AgentBinary = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())

/** An added account's agent home and the CLI binary run against it. */
export interface AccountHome {
  readonly dir: string
  readonly binary: string
}

/** A model the agent no longer lists, such as a thread's saved model or a typed id. */
export const unlistedModel = (id: string, provider: ProviderId): ModelInfo => ({
  id,
  label: id,
  provider,
  efforts: [],
  defaultEffort: null,
  fastMode: false,
  autoMode: false,
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
  /** The agent's own command, such as Claude's `/compact`. Absent on skills and on commands a user, project or plugin defines. */
  builtin: Schema.optionalKey(Schema.Boolean),
  /** Whether a skill is the user's own or the project's. Absent when it comes from elsewhere, such as a plugin. */
  scope: Schema.optionalKey(Schema.Literals(["user", "project"])),
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

export const QuestionOption = Schema.Struct({ label: Schema.String, description: Schema.String })
export type QuestionOption = typeof QuestionOption.Type

export const Question = Schema.Struct({
  /** What the answer is keyed by when it goes back to the agent. */
  id: Schema.String,
  /** A short tag such as "Auth method"; may be empty. */
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(QuestionOption),
  multiSelect: Schema.Boolean,
  /** Whether the user may type an answer instead of picking an option. */
  allowsText: Schema.Boolean,
  /** The typed answer is masked on screen. */
  secret: Schema.Boolean,
})
export type Question = typeof Question.Type

/** The agent asked the user one or more questions (Claude's AskUserQuestion, Codex's request_user_input). */
export const QuestionRequest = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  provider: ProviderId,
  questions: Schema.Array(Question),
})
export type QuestionRequest = typeof QuestionRequest.Type

/** Picked option labels or the typed text, keyed by question id. A question left out was skipped. */
export const QuestionAnswers = Schema.Record(Schema.String, Schema.Array(Schema.String))
export type QuestionAnswers = typeof QuestionAnswers.Type

/** An agent asked the user for a secret through the MCP `request_secret` tool. The value never travels with it. */
export const SecretRequest = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  /** The `Secrets` name the value is stored under. */
  name: Schema.String,
  description: Schema.String,
})
export type SecretRequest = typeof SecretRequest.Type

/** How much of the model's context window the conversation fills, as of its latest model request. */
export const ContextWindow = Schema.Struct({ usedTokens: Schema.Number, maxTokens: Schema.Number })
export type ContextWindow = typeof ContextWindow.Type

export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.optional(Schema.Number),
  context: Schema.optional(ContextWindow),
})
export type TokenUsage = typeof TokenUsage.Type

/** Tokens one model spent across a thread's transcripts. The four counts add up to its total. */
export const ModelUsage = Schema.Struct({
  model: Schema.String,
  /** Input billed at the full rate, without cache reads or writes. */
  inputTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  /** Includes reasoning tokens. */
  outputTokens: Schema.Number,
})
export type ModelUsage = typeof ModelUsage.Type

export const ThreadUsage = Schema.Struct({
  models: Schema.Array(ModelUsage),
  /** Transcripts counted: the main session plus one per sub-agent or workflow agent. */
  transcripts: Schema.Number,
})
export type ThreadUsage = typeof ThreadUsage.Type

/** Plan limits of one signed-in account. `limits` is null when the account has none, such as an API key. */
export const AccountLimits = Schema.Struct({
  provider: ProviderId,
  accountId: Schema.NullOr(Schema.String),
  limits: Schema.NullOr(PlanLimits),
})
export type AccountLimits = typeof AccountLimits.Type

export const SubagentStatus = Schema.Literals(["running", "completed", "failed", "stopped"])
export type SubagentStatus = typeof SubagentStatus.Type

/** A sub-agent the thread's agent spawned, as last reported by the provider. */
export const Subagent = Schema.Struct({
  id: Schema.String,
  /** What it was asked to do: the task description or a summary of its prompt. */
  label: Schema.String,
  /**
   * What the sub-agent's own tool calls carry as `parentCallId`: the tool call that spawned it on
   * Claude, its own thread id on Codex. Null until the provider has said which.
   */
  callId: Schema.NullOr(Schema.String),
  status: SubagentStatus,
  /** The latest one-line progress summary, or the final summary once it ended. */
  summary: Schema.NullOr(Schema.String),
  lastTool: Schema.NullOr(Schema.String),
  toolUses: Schema.NullOr(Schema.Number),
  tokens: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
})
export type Subagent = typeof Subagent.Type

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
  /** Questions the user answers with their next message; the turn does not wait for them. */
  Schema.Struct({ type: Schema.Literal("questions_posted"), text: Schema.String, questions: Schema.Array(Question) }),
  /** Carries the sub-agent's full current state, not a patch. Never part of the transcript. */
  Schema.Struct({ type: Schema.Literal("subagent_updated"), subagent: Subagent }),
  /** Raised by the built-in MCP server, not the provider, while a turn runs. */
  Schema.Struct({ type: Schema.Literal("secret_requested"), request: SecretRequest }),
  Schema.Struct({ type: Schema.Literal("secret_resolved"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("turn_completed"), usage: Schema.optional(TokenUsage) }),
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
  /** Null leaves the model's default effort. */
  readonly effort: string | null
  readonly fastMode: boolean
  /** False hides the skills and commands in the user's own agent home from the agent. */
  readonly userSkills: boolean
  readonly accessMode: AccessMode
  /** Provider session or thread id from a previous turn, for resume. */
  readonly resumeSessionId: string | null
  /** The added account to run as. Null uses the CLI's own login and home, the only one Muse Code has. */
  readonly home: AccountHome | null
  /** The built-in hinacode MCP server, authenticated as this thread. */
  readonly mcpServer: McpConnection
  /** hinacode's own instructions for the agent, appended to its system prompt. */
  readonly instructions: string
}

/** A Streamable HTTP MCP endpoint plus the headers that authenticate the caller. */
export interface McpConnection {
  readonly url: string
  readonly headers: { readonly authorization: string }
}
