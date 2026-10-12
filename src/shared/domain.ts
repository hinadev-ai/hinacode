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

export const ChangedFileStatus = Schema.Literals(["added", "modified", "deleted", "untracked", "conflict"])
export type ChangedFileStatus = typeof ChangedFileStatus.Type

/** What a worktree changed since it forked from its base ref, committed or not. */
export const WorktreeChanges = Schema.Struct({
  baseRef: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: ChangedFileStatus })),
  /** One unified diff covering every file in `files`. */
  patch: Schema.String,
})
export type WorktreeChanges = typeof WorktreeChanges.Type

export const FsEntryKind = Schema.Literals(["file", "dir", "symlink"])
export type FsEntryKind = typeof FsEntryKind.Type

/** One entry of a folder listing in a thread's working directory. */
export const FsEntry = Schema.Struct({
  name: Schema.String,
  /** Relative to the listed root, `/`-separated. */
  path: Schema.String,
  kind: FsEntryKind,
  /** Gitignored, itself or through a parent folder. */
  ignored: Schema.Boolean,
  /** For a folder, the most notable status among the files under it. */
  gitStatus: Schema.NullOr(ChangedFileStatus),
})
export type FsEntry = typeof FsEntry.Type

/** The start of a file, as the file viewer shows it. */
export const FsFileContent = Schema.Struct({
  /** Empty for a binary file. */
  content: Schema.String,
  /** The file is longer than what `content` holds. */
  truncated: Schema.Boolean,
  binary: Schema.Boolean,
})
export type FsFileContent = typeof FsFileContent.Type

export const GitCommit = Schema.Struct({
  hash: Schema.String,
  parents: Schema.Array(Schema.String),
  subject: Schema.String,
  author: Schema.String,
  authoredAt: Timestamp,
  /** Decorations as `git log` prints them, e.g. `HEAD`, `main`, `origin/main`, `tag: v1`. */
  refs: Schema.Array(Schema.String),
})
export type GitCommit = typeof GitCommit.Type

/** One commit's changes against its first parent. */
export const CommitDiff = Schema.Struct({
  patch: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: ChangedFileStatus })),
})
export type CommitDiff = typeof CommitDiff.Type

/** Whether kkcode can operate GitHub through the `gh` CLI on this machine. */
export const GitHubAuth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("missing") }),
  Schema.Struct({ type: Schema.Literal("signedOut") }),
  Schema.Struct({ type: Schema.Literal("signedIn"), host: Schema.String, login: Schema.String }),
])
export type GitHubAuth = typeof GitHubAuth.Type

export const PullRequestStatus = Schema.Literals(["draft", "open", "merged", "closed"])
export type PullRequestStatus = typeof PullRequestStatus.Type

export const ChecksStatus = Schema.Literals(["passing", "failing", "pending"])
export type ChecksStatus = typeof ChecksStatus.Type

export const ReviewStatus = Schema.Literals(["approved", "changesRequested", "reviewRequired"])
export type ReviewStatus = typeof ReviewStatus.Type

/** A GitHub pull request as `gh pr view` reports it. */
export const PullRequest = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  status: PullRequestStatus,
  /** Null when the head commit has no checks, so a repository without CI never looks green. */
  checks: Schema.NullOr(ChecksStatus),
  /** Null when the repository requires no review and nobody reviewed. */
  review: Schema.NullOr(ReviewStatus),
})
export type PullRequest = typeof PullRequest.Type

export const ThreadStatus = Schema.Literals(["idle", "running", "awaiting_approval", "settled", "archived"])
export type ThreadStatus = typeof ThreadStatus.Type

/** A turn is in flight: the agent may be writing to the thread's working directory. */
export const isThreadBusy = (status: ThreadStatus) => status === "running" || status === "awaiting_approval"

/**
 * How much an agent may do without asking. `supervised` asks before commands and edits, `auto` lets
 * routine work through and asks for the rest, `full` never asks.
 */
export const AccessMode = Schema.Literals(["supervised", "auto", "full"])
export type AccessMode = typeof AccessMode.Type

export const Thread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  /** Null means the thread runs in the project root. */
  worktreeId: Schema.NullOr(Schema.String),
  title: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  /** Reasoning effort for the next turn. Null leaves the model's default. */
  effort: Schema.NullOr(Schema.String),
  /** Run turns on the model's faster, pricier service tier. */
  fastMode: Schema.Boolean,
  /** Applies from the next turn, or right away on a live Claude session. */
  accessMode: AccessMode,
  /** Claude session_id or Codex thread id, used to resume. */
  providerSessionId: Schema.NullOr(Schema.String),
  status: ThreadStatus,
  sortIndex: Schema.Number,
  /**
   * Provenance, not ownership: `user`, `automation:<automationId>` for threads an automation started,
   * or `thread:<threadId>` for threads an agent started with the MCP `create_thread` tool.
   */
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
  "system",
  "light",
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
  /** Claude model that names a thread and its branch from the first message. */
  textGenerationModel: Schema.String,
})
export type Settings = typeof Settings.Type

export const defaultSettings: Settings = {
  locale: "en",
  keybindings: {},
  defaultModel: { claude: null, codex: null },
  automations: { bindHost: "127.0.0.1", port: 48080 },
  appearance: { theme: "system", fontSize: 16, uiFont: null, monoFont: null },
  textGenerationModel: "claude-sonnet-5-5",
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
