import { Schema } from "effect"
import { ProviderId, TokenUsage } from "./agent.ts"

/** ISO-8601 UTC timestamp, as stored in SQLite. */
export const Timestamp = Schema.String
export type Timestamp = typeof Timestamp.Type

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String,
  setupScript: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Project = typeof Project.Type

export const WorktreeStatus = Schema.Literals(["preparing", "ready", "failed", "removed"])
export type WorktreeStatus = typeof WorktreeStatus.Type

export const Worktree = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  status: WorktreeStatus,
  setupLog: Schema.String,
  createdAt: Timestamp,
})
export type Worktree = typeof Worktree.Type

export const ChangedFileStatus = Schema.Literals(["added", "modified", "deleted", "untracked"])
export type ChangedFileStatus = typeof ChangedFileStatus.Type

/** What a worktree changed since it forked from its base ref, committed or not. */
export const WorktreeChanges = Schema.Struct({
  baseRef: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: ChangedFileStatus })),
  /** One unified diff covering every file in `files`. */
  patch: Schema.String,
})
export type WorktreeChanges = typeof WorktreeChanges.Type

export const PullRequestState = Schema.Struct({
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  url: Schema.String,
})
export type PullRequestState = typeof PullRequestState.Type

export const ThreadStatus = Schema.Literals(["idle", "running", "awaiting_approval", "settled", "archived"])
export type ThreadStatus = typeof ThreadStatus.Type

export const Thread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  /** Null means the thread runs in the project root. */
  worktreeId: Schema.NullOr(Schema.String),
  title: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  /** Claude session_id or Codex thread id, used to resume. */
  providerSessionId: Schema.NullOr(Schema.String),
  status: ThreadStatus,
  sortIndex: Schema.Number,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Thread = typeof Thread.Type

export const ToolCallStatus = Schema.Literals(["running", "done", "error"])
export type ToolCallStatus = typeof ToolCallStatus.Type

export const MessagePart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    callId: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    status: ToolCallStatus,
  }),
  Schema.Struct({ type: Schema.Literal("file_change"), path: Schema.String, diff: Schema.String }),
])
export type MessagePart = typeof MessagePart.Type

export const MessageRole = Schema.Literals(["user", "assistant"])
export type MessageRole = typeof MessageRole.Type

export const Message = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  createdAt: Timestamp,
  completedAt: Schema.NullOr(Timestamp),
  usage: Schema.NullOr(TokenUsage),
})
export type Message = typeof Message.Type

export const Locale = Schema.Literals(["en", "zh-TW"])
export type Locale = typeof Locale.Type

/**
 * Settings the renderer can read and write. `linear.apiKey` is a setting row too, but it is
 * encrypted with safeStorage and never leaves the main process, so it is not part of this shape.
 */
export const Settings = Schema.Struct({
  locale: Locale,
  /** CommandId -> canonical chord such as "mod+shift+p". Only user overrides are stored. */
  keybindings: Schema.Record(Schema.String, Schema.String),
  defaultModel: Schema.Struct({
    claude: Schema.NullOr(Schema.String),
    codex: Schema.NullOr(Schema.String),
  }),
})
export type Settings = typeof Settings.Type

export const defaultSettings: Settings = {
  locale: "en",
  keybindings: {},
  defaultModel: { claude: null, codex: null },
}

export const PullRequestLink = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  url: Schema.String,
  createdAt: Timestamp,
})
export type PullRequestLink = typeof PullRequestLink.Type
/** A listening TCP port and the process that owns it. */
export const OpenPort = Schema.Struct({
  port: Schema.Number,
  pid: Schema.Number,
  command: Schema.String,
  /** Null when the process belongs to another user. */
  cwd: Schema.NullOr(Schema.String),
})
export type OpenPort = typeof OpenPort.Type
