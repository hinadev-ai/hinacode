import { Schema } from "effect"
import { ProviderId, Question, TokenUsage } from "./agent.ts"
import { PullRequestSelector } from "./github.ts"
import { UsageLimit } from "./limits.ts"

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

/** What the working tree changed since a base, committed or not, new files included. */
export const Changes = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: ChangedFileStatus })),
  /** One unified diff covering every file in `files`. */
  patch: Schema.String,
})
export type Changes = typeof Changes.Type

/** Worktree fork or latest turn baseline. */
export const ChangesScope = Schema.Literals(["worktree", "turn"])
export type ChangesScope = typeof ChangesScope.Type

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
  /** The author's login. */
  author: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
})
export type PullRequest = typeof PullRequest.Type

export const CheckRunStatus = Schema.Literals(["passing", "failing", "pending", "skipped"])
export type CheckRunStatus = typeof CheckRunStatus.Type

/** One entry of a pull request's check rollup: a check run or a commit status. */
export const CheckRun = Schema.Struct({
  name: Schema.String,
  status: CheckRunStatus,
  /** Where the run's logs live, when GitHub reports one. */
  url: Schema.NullOr(Schema.String),
})
export type CheckRun = typeof CheckRun.Type

/** `unknown` while GitHub is still computing it, which it does lazily after a push. */
export const Mergeable = Schema.Literals(["mergeable", "conflicting", "unknown"])
export type Mergeable = typeof Mergeable.Type

/** Everything the PR tab shows. Fetched only while the tab is open, since the body can be large. */
export const PullRequestDetail = Schema.Struct({
  ...PullRequest.fields,
  body: Schema.String,
  baseRef: Schema.String,
  headRef: Schema.String,
  mergeable: Mergeable,
  checkRuns: Schema.Array(CheckRun),
})
export type PullRequestDetail = typeof PullRequestDetail.Type

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"])
export type MergeMethod = typeof MergeMethod.Type

/** Where a thread's new worktree starts: a new branch forked from `baseRef`, or an open pull request's head. */
export const WorktreeSource = Schema.Union([
  Schema.TaggedStruct("branch", { baseRef: Schema.String }),
  Schema.TaggedStruct("pullRequest", { selector: PullRequestSelector }),
])
export type WorktreeSource = typeof WorktreeSource.Type

/** An open pull request the worktree picker can check out. */
export const OpenPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  headRefName: Schema.String,
  author: Schema.String,
  isDraft: Schema.Boolean,
})
export type OpenPullRequest = typeof OpenPullRequest.Type

export const ThreadStatus = Schema.Literals(["idle", "running", "awaiting_approval", "limited", "archived"])
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
  usageLimit: Schema.NullOr(UsageLimit),
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
    /** Set when a sub-agent made the call: the `callId` of the sub-agent it belongs to. */
    parentCallId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("file_change"), path: Schema.String, diff: Schema.String }),
  Schema.Struct({ type: Schema.Literal("attachment"), attachment: Attachment }),
  /** Questions the agent posted without waiting; `text` is how they read once answered. */
  Schema.Struct({ type: Schema.Literal("questions"), text: Schema.String, questions: Schema.Array(Question) }),
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

/** A thread change that can pull the user back: its turn finished, it is waiting on them, or it stopped short. */
export const ThreadAlert = Schema.Literals(["completed", "needsInput", "failed"])
export type ThreadAlert = typeof ThreadAlert.Type

/** Which alerts raise a desktop notification, and whether a chime plays with it. */
export const NotificationSettings = Schema.Struct({
  completed: Schema.Boolean,
  needsInput: Schema.Boolean,
  failed: Schema.Boolean,
  sound: Schema.Boolean,
})
export type NotificationSettings = typeof NotificationSettings.Type

/** Whether the OS lets kkcode show notifications. `unknown` where kkcode cannot ask, which is everywhere but macOS. */
export const NotificationPermission = Schema.Literals(["granted", "denied", "notDetermined", "unknown"])
export type NotificationPermission = typeof NotificationPermission.Type

/** `noAnswer` while the macOS prompt waits for the user. */
export const PermissionRequestOutcome = Schema.Literals(["shown", "refused", "noAnswer"])
export type PermissionRequestOutcome = typeof PermissionRequestOutcome.Type

export const ArchiveSettings = Schema.Struct({
  /** Archive a thread once every pull request linked to it is merged. */
  whenMerged: Schema.Boolean,
  /** Archiving also deletes the thread's worktree folder, and its branch when merged into its base. */
  removeWorktree: Schema.Boolean,
})
export type ArchiveSettings = typeof ArchiveSettings.Type

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
  /** The access mode new threads start with. */
  defaultAccessMode: AccessMode,
  notifications: NotificationSettings,
  archive: ArchiveSettings,
})
export type Settings = typeof Settings.Type

export const defaultSettings: Settings = {
  locale: "en",
  keybindings: {},
  defaultModel: { claude: null, codex: null },
  automations: { bindHost: "127.0.0.1", port: 48080 },
  appearance: { theme: "system", fontSize: 16, uiFont: null, monoFont: null },
  textGenerationModel: "claude-sonnet-5-5",
  defaultAccessMode: "full",
  notifications: { completed: true, needsInput: true, failed: true, sound: true },
  archive: { whenMerged: false, removeWorktree: false },
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

/** An integrated terminal: a shell in the thread's workspace. Lives in memory and ends with the app. */
export const TerminalSession = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  cwd: Schema.String,
  cols: Schema.Number,
  rows: Schema.Number,
  status: Schema.Literals(["running", "exited"]),
  exitCode: Schema.NullOr(Schema.Number),
})
export type TerminalSession = typeof TerminalSession.Type

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

/** A message that matched a global search, newest first. */
export const ThreadSearchHit = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  projectId: Schema.String,
  messageId: Schema.String,
  /** About 80 characters of the message around the first match. */
  snippet: Schema.String,
  at: Timestamp,
})
export type ThreadSearchHit = typeof ThreadSearchHit.Type

/** A line in the open thread's workspace that matched a global search. */
export const FileSearchHit = Schema.Struct({
  /** Relative to the workspace root. */
  path: Schema.String,
  line: Schema.Number,
  /** 1-based, in UTF-16 code units, of the first match on the line. */
  column: Schema.Number,
  /** The line around its first match, trimmed for long lines. */
  text: Schema.String,
})
export type FileSearchHit = typeof FileSearchHit.Type
