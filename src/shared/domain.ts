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
  /** The cloud this project lives on, set by the desktop on every project a cloud returns. Absent on this desktop. */
  environmentId: Schema.optionalKey(Schema.String),
  /**
   * The GitHub repository the root checks out, as lower-case `owner/name`, then the root's folder inside the repository
   * when it is not the top level. Only `projects.list` sets it. Absent without a GitHub `origin`.
   */
  repository: Schema.optionalKey(Schema.String),
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
  /** The head commit oid, so a watcher can tell a push apart from the code it already reported on. */
  head: Schema.String,
  mergeable: Mergeable,
  checkRuns: Schema.Array(CheckRun),
})
export type PullRequestDetail = typeof PullRequestDetail.Type

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"])
export type MergeMethod = typeof MergeMethod.Type

/** A branch or other ref, or an open pull request, as picked in the composer. */
export const CheckoutTarget = Schema.Union([
  Schema.TaggedStruct("branch", { ref: Schema.String }),
  Schema.TaggedStruct("pullRequest", { selector: PullRequestSelector }),
])
export type CheckoutTarget = typeof CheckoutTarget.Type

/**
 * Where a thread's first turn runs. `local` switches the project root to the target. `worktree` makes a new
 * checkout: a new branch forked from the target ref, or the pull request's head.
 */
export const WorkspaceChoice = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  target: CheckoutTarget,
})
export type WorkspaceChoice = typeof WorkspaceChoice.Type

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
  /** The agent account the thread bills to. Null is the CLI's own login. Fixed once the thread has a session. */
  accountId: Schema.NullOr(Schema.String),
  /** Claude session_id or Codex thread id, used to resume. */
  providerSessionId: Schema.NullOr(Schema.String),
  status: ThreadStatus,
  usageLimit: Schema.NullOr(UsageLimit),
  sortIndex: Schema.Number,
  /** When the user pinned the thread to the top of the sidebar, or null when it is not pinned. */
  pinnedAt: Schema.NullOr(Timestamp),
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

/**
 * An element the user picked in the in-app browser. The page produced every field, so the limits hold even when
 * its scripts tamper with the picker, and agents read it as page content, not as instructions.
 */
export const PickedElement = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  selector: Schema.String.check(Schema.isMaxLength(1000)),
  /** The element's outerHTML, cut to 4000 characters. */
  html: Schema.String.check(Schema.isMaxLength(4000)),
  text: Schema.String.check(Schema.isMaxLength(500)),
  /** The React components it sits in, nearest first. Empty unless the page is a React development build. */
  components: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(5)),
})
export type PickedElement = typeof PickedElement.Type

/** A file the user attached, copied into the app's attachments dir so `path` outlives the source. */
export const Attachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Absolute path of the staged copy. */
  path: Schema.String,
  mime: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  bytes: Schema.Number,
  /** Set when the image is a screenshot of an element picked in the in-app browser. */
  element: Schema.optional(PickedElement),
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

export const Locale = Schema.Literals(["en", "zh-TW", "ja"])
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

/** Features that are off until the user opts in. Each may change shape or go away. */
export const ExperimentalSettings = Schema.Struct({
  /**
   * Gives each thread a disposable Linux desktop on the user's sbx host: the Tiny VM side panel view,
   * the `vm_*` MCP tools, and the agent instructions that describe them.
   */
  tinyVm: Schema.Boolean,
})
export type ExperimentalSettings = typeof ExperimentalSettings.Type

/** Settings of this desktop, whichever machine a thread runs on. Only the renderer reads them. */
export const ClientSettings = Schema.Struct({
  locale: Locale,
  /** CommandId -> canonical chord such as "mod+shift+p". Only user overrides are stored. */
  keybindings: Schema.Record(Schema.String, Schema.String),
  appearance: Appearance,
  notifications: NotificationSettings,
})
export type ClientSettings = typeof ClientSettings.Type

export const defaultClientSettings: ClientSettings = {
  locale: "en",
  keybindings: {},
  appearance: { theme: "system", fontSize: 16, uiFont: null, monoFont: null },
  notifications: { completed: true, needsInput: true, failed: true, sound: true },
}

/**
 * Settings of the environment agents run in: this desktop, or a paired cloud. `linear.apiKey`
 * is a setting row too, but it is encrypted with safeStorage and never leaves the main process, so it is not part
 * of this shape.
 */
export const Settings = Schema.Struct({
  defaultModel: Schema.Struct({
    claude: Schema.NullOr(Schema.String),
    codex: Schema.NullOr(Schema.String),
    muse: Schema.NullOr(Schema.String),
  }),
  /** Model ids the thread model picker lists per agent, in any order. Empty lists every model the agent has. */
  modelPresets: Schema.Struct({
    claude: Schema.Array(Schema.String),
    codex: Schema.Array(Schema.String),
    muse: Schema.Array(Schema.String),
  }),
  /** The account new threads of each agent start on. Null is the CLI's own login. */
  defaultAccount: Schema.Struct({
    claude: Schema.NullOr(Schema.String),
    codex: Schema.NullOr(Schema.String),
    muse: Schema.NullOr(Schema.String),
  }),
  /** Where the automation webhook listener binds. 0.0.0.0 exposes it on the LAN and Tailscale. */
  automations: Schema.Struct({
    bindHost: Schema.String,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  /** The remote control listener phones connect to. Off by default; 0.0.0.0 exposes it on the LAN and Tailscale. */
  remote: Schema.Struct({
    enabled: Schema.Boolean,
    bindHost: Schema.String,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  /** Claude model that names a thread and its branch from the first message. */
  textGenerationModel: Schema.String,
  /** The access mode new threads start with. */
  defaultAccessMode: AccessMode,
  archive: ArchiveSettings,
  experimental: ExperimentalSettings,
  /** Absolute directory for new worktrees, one folder per project. Null keeps them in `.kkcode-worktrees` beside each project. */
  worktreeRoot: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\//))),
})
export type Settings = typeof Settings.Type

export const defaultSettings: Settings = {
  defaultModel: { claude: null, codex: null, muse: null },
  modelPresets: { claude: [], codex: [], muse: [] },
  defaultAccount: { claude: null, codex: null, muse: null },
  automations: { bindHost: "127.0.0.1", port: 48080 },
  remote: { enabled: false, bindHost: "0.0.0.0", port: 48081 },
  textGenerationModel: "claude-sonnet-5-5",
  defaultAccessMode: "full",
  archive: { whenMerged: false, removeWorktree: false },
  experimental: { tinyVm: false },
  worktreeRoot: null,
}

/** A cloud this desktop paired with. `id` is the cloud's own id; its pairing token is the secret `environment.<id>.token`. */
export const Environment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  createdAt: Timestamp,
})
export type Environment = typeof Environment.Type

/**
 * The desktop's link to a cloud. `unauthorized` and `incompatible` stop retrying: only a new pairing URL, or
 * updating one side so both speak the same `REMOTE_PROTOCOL_VERSION`, brings it back.
 */
export const EnvironmentStatus = Schema.Literals(["connecting", "connected", "offline", "unauthorized", "incompatible"])
export type EnvironmentStatus = typeof EnvironmentStatus.Type

/** Every paired cloud with its link. `lastSeenAt` is when it last answered, null before the first connection. */
export const Environments = Schema.Struct({
  clouds: Schema.Array(
    Schema.Struct({ ...Environment.fields, status: EnvironmentStatus, lastSeenAt: Schema.NullOr(Timestamp) }),
  ),
})
export type Environments = typeof Environments.Type

/** Who drives a tiny VM's pointer and keyboard. The agent's pointer and keyboard tools wait while it is `user`. */
export const VmControl = Schema.Literals(["agent", "user"])
export type VmControl = typeof VmControl.Type

/** A thread's tiny VM: an sbx sandbox kkcode created for it. */
export const ThreadVm = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.Literal("starting") }),
  Schema.Struct({ status: Schema.Literal("running"), sandboxId: Schema.String, control: Schema.Literal("agent") }),
  Schema.Struct({
    status: Schema.Literal("running"),
    sandboxId: Schema.String,
    control: Schema.Literal("user"),
    /** An agent pointer or keyboard tool is waiting for the user to hand control back. */
    agentWaiting: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
])
export type ThreadVm = typeof ThreadVm.Type

/** Whether kkcode reaches the sbx host that tiny VMs run on, as Settings shows it. */
export const VmHostStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("connected"),
    url: Schema.String,
    sandboxes: Schema.Number,
    maxSandboxes: Schema.Number,
  }),
  /** Neither `SBX_URL` and `SBX_TOKEN` nor the config file `sbx login` writes. */
  Schema.Struct({ status: Schema.Literal("notConfigured") }),
  Schema.Struct({ status: Schema.Literal("unreachable"), url: Schema.String, message: Schema.String }),
])
export type VmHostStatus = typeof VmHostStatus.Type

/** What a pull request watch can report. The absence of news, such as pending checks, is not an event. */
export const WatchEventKind = Schema.Literals([
  "checksFailed",
  "checksPassed",
  "reviewChanged",
  "conflicting",
  "mergedOrClosed",
])
export type WatchEventKind = typeof WatchEventKind.Type

export const allWatchEventKinds: ReadonlyArray<WatchEventKind> = [
  "checksFailed",
  "checksPassed",
  "reviewChanged",
  "conflicting",
  "mergedOrClosed",
]

/** The last state of a watched pull request that its thread was told about. */
export const PullRequestWatchSnapshot = Schema.Struct({
  status: PullRequestStatus,
  checks: Schema.NullOr(ChecksStatus),
  review: Schema.NullOr(ReviewStatus),
  mergeable: Mergeable,
  /** Head commit oid. Check news is per head, so a push makes the same failure news again. */
  head: Schema.String,
  /** Names of the failing checks, so a second failure still fires while checks stay failing. */
  failingChecks: Schema.Array(Schema.String),
})
export type PullRequestWatchSnapshot = typeof PullRequestWatchSnapshot.Type

/**
 * A live watch on one linked pull request. `generation` is fresh every time the watch is started, so a
 * poll that read GitHub under an older generation can tell its result is stale and drop it. `snapshot` is
 * null until the first poll, and it only moves when a poll's news was delivered or it found no news.
 */
export const PullRequestWatch = Schema.Struct({
  generation: Schema.String,
  events: Schema.Array(WatchEventKind),
  snapshot: Schema.NullOr(PullRequestWatchSnapshot),
  wakes: Schema.Int,
  /** Consecutive polls that could not read the pull request. */
  failures: Schema.Int,
  lastPolledAt: Schema.NullOr(Timestamp),
  lastWokeAt: Schema.NullOr(Timestamp),
})
export type PullRequestWatch = typeof PullRequestWatch.Type

export const PullRequestLink = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  url: Schema.String,
  createdAt: Timestamp,
  /** Null when nobody watches this link. */
  watch: Schema.NullOr(PullRequestWatch),
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

/** A count of UTF-16 code units, the unit JavaScript strings slice by. */
export const TerminalOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A session with its kept output from `offset`, where the first character of `data` sits in the session's output. */
export const TerminalAttachment = Schema.Struct({
  session: TerminalSession,
  offset: TerminalOffset,
  data: Schema.String,
})
export type TerminalAttachment = typeof TerminalAttachment.Type

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

/** What Settings > Remote shows: whether phones can connect right now, and how many do. */
export const RemoteStatus = Schema.Struct({
  listening: Schema.Boolean,
  listenError: Schema.NullOr(Schema.String),
  connected: Schema.Int,
})
export type RemoteStatus = typeof RemoteStatus.Type

/** Everything a phone needs to connect. `hosts` are the addresses this machine answers on, Tailscale first. */
export const RemotePairing = Schema.Struct({
  hosts: Schema.Array(Schema.String),
  port: Schema.Int,
  token: Schema.String,
})
export type RemotePairing = typeof RemotePairing.Type
