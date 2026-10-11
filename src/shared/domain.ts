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
  /** The user allowed the repository's own Claude settings (hooks, permission rules, CLAUDE.md) to load. */
  trusted: Schema.Boolean,
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

/** A turn is in flight: the agent may be writing to the thread's working directory. */
export const isThreadBusy = (status: ThreadStatus) => status === "running" || status === "awaiting_approval"

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
  /** `user`, or `automation:<automationId>` for threads an automation started. */
  createdBy: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Thread = typeof Thread.Type

export const ToolCallStatus = Schema.Literals(["running", "done", "error"])
export type ToolCallStatus = typeof ToolCallStatus.Type

/** A file the user attached, copied into the app's attachments dir so `path` outlives the source. */
export const Attachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Absolute path of the staged copy. */
  path: Schema.String,
  mime: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  bytes: Schema.Number,
})
export type Attachment = typeof Attachment.Type

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
  Schema.Struct({ type: Schema.Literal("attachment"), attachment: Attachment }),
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

export const ThemeId = Schema.Literals([
  "default",
  "catppuccin-mocha",
  "catppuccin-latte",
  "tokyo-night",
  "rose-pine",
  "gruvbox-dark",
])
export type ThemeId = typeof ThemeId.Type

export const Appearance = Schema.Struct({
  theme: ThemeId,
  /** Root font size in px. Everything sized in rem scales with it. */
  fontSize: Schema.Int.check(Schema.isBetween({ minimum: 12, maximum: 20 })),
  /** Installed font family names. Null uses the bundled DM Sans and Geist Mono. */
  uiFont: Schema.NullOr(Schema.String),
  monoFont: Schema.NullOr(Schema.String),
})
export type Appearance = typeof Appearance.Type

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
  /** Where the automation webhook listener binds. 0.0.0.0 exposes it on the LAN and Tailscale. */
  automations: Schema.Struct({
    bindHost: Schema.String,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  appearance: Appearance,
})
export type Settings = typeof Settings.Type

export const defaultSettings: Settings = {
  locale: "en",
  keybindings: {},
  defaultModel: { claude: null, codex: null },
  automations: { bindHost: "127.0.0.1", port: 48080 },
  appearance: { theme: "default", fontSize: 16, uiFont: null, monoFont: null },
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

/**
 * What starts an automation. A webhook's HMAC secret lives in Secrets, never in this shape,
 * so the renderer only ever sees it once, in the `automations.create` response.
 */
export const AutomationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("webhook") }),
  Schema.Struct({
    type: Schema.Literal("github.issue"),
    /** `owner/name` */
    repo: Schema.String,
    labels: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("linear.issue"),
    teamKey: Schema.String,
    stateName: Schema.optionalKey(Schema.String),
    label: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("slack.mention"),
    /** A Slack search modifier target such as `#general`. Omitted searches every channel. */
    channel: Schema.optionalKey(Schema.String),
    botUserId: Schema.String,
  }),
])
export type AutomationTrigger = typeof AutomationTrigger.Type
export type AutomationTriggerType = AutomationTrigger["type"]

export const AutomationRunStatus = Schema.Literals(["started", "skipped", "failed"])
export type AutomationRunStatus = typeof AutomationRunStatus.Type

export const AutomationRun = Schema.Struct({
  id: Schema.String,
  automationId: Schema.String,
  /** Null when the run was skipped or failed before its thread existed. */
  threadId: Schema.NullOr(Schema.String),
  /** Delivery id, issue id or message ts. Null for poll failures, which belong to no event. */
  eventKey: Schema.NullOr(Schema.String),
  status: AutomationRunStatus,
  error: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
})
export type AutomationRun = typeof AutomationRun.Type

export const Automation = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  /** `{{path.to.field}}` placeholders are filled from the event payload. */
  promptTemplate: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  runInWorktree: Schema.Boolean,
  /** Rendered like the prompt, then slugified. Null picks a branch from the automation name. */
  branchTemplate: Schema.NullOr(Schema.String),
  /** Poll position: an ISO timestamp, or a Slack message ts. Null until the first poll. */
  cursor: Schema.NullOr(Schema.String),
  polledAt: Schema.NullOr(Timestamp),
  lastRun: Schema.NullOr(AutomationRun),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Automation = typeof Automation.Type
