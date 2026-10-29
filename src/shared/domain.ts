import { Effect, Schema } from "effect"
import { AgentProfileName, Compaction, ForkPoint, ProviderId, Question, TokenUsage } from "./agent.ts"
import { PickedDeviceElement } from "./device.ts"
import { parsePullRequestSelector, PullRequestSelector } from "./github.ts"
import { UsageLimit } from "./limits.ts"
import { EntrySource } from "./relayMachines.ts"

export const Timestamp = Schema.String
export type Timestamp = typeof Timestamp.Type

export const ProjectKind = Schema.Literals(["folder", "chats"])
export type ProjectKind = typeof ProjectKind.Type

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String,
  setupScript: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  environmentId: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  linearReview: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  kind: ProjectKind.pipe(Schema.withDecodingDefaultKey(Effect.succeed("folder" as const))),
})
export type Project = typeof Project.Type

export const chatFolder = (chatsRoot: string, threadId: string) =>
  `${chatsRoot.replace(/[\\/]+$/, "")}${chatsRoot.includes("\\") ? "\\" : "/"}${threadId}`

export const threadFolder = (project: Pick<Project, "kind" | "rootPath">, threadId: string) =>
  project.kind === "chats" ? chatFolder(project.rootPath, threadId) : project.rootPath

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

export const CheckoutState = Schema.Literals(["clean", "dirty", "missing"])
export type CheckoutState = typeof CheckoutState.Type

export const WorktreeCheckout = Schema.Struct({ id: Schema.String, state: CheckoutState })
export type WorktreeCheckout = typeof WorktreeCheckout.Type

export const ChangedFileStatus = Schema.Literals(["added", "modified", "deleted", "untracked", "conflict"])
export type ChangedFileStatus = typeof ChangedFileStatus.Type

export const Changes = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: ChangedFileStatus })),
  patch: Schema.String,
})
export type Changes = typeof Changes.Type

export const ChangesScope = Schema.Literals(["worktree", "turn"])
export type ChangesScope = typeof ChangesScope.Type

export const FsEntryKind = Schema.Literals(["file", "dir", "symlink"])
export type FsEntryKind = typeof FsEntryKind.Type

export const FsEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: FsEntryKind,
  ignored: Schema.Boolean,
  gitStatus: Schema.NullOr(ChangedFileStatus),
})
export type FsEntry = typeof FsEntry.Type

export const FsFileContent = Schema.Struct({
  content: Schema.String,
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
  refs: Schema.Array(Schema.String),
})
export type GitCommit = typeof GitCommit.Type

export const CommitDiff = Schema.Struct({
  patch: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: ChangedFileStatus })),
})
export type CommitDiff = typeof CommitDiff.Type

export const GitHubAuth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("missing") }),
  Schema.Struct({ type: Schema.Literal("signedOut") }),
  Schema.Struct({ type: Schema.Literal("signedIn"), host: Schema.String, login: Schema.String }),
])
export type GitHubAuth = typeof GitHubAuth.Type

export const GitHubRateLimit = Schema.Struct({
  resource: Schema.String,
  limit: Schema.Number,
  remaining: Schema.Number,
  used: Schema.Number,
  resetsAt: Schema.Number,
})
export type GitHubRateLimit = typeof GitHubRateLimit.Type

export const UpdateState = Schema.Union([
  Schema.Struct({ type: Schema.Literal("unsupported") }),
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("checking") }),
  Schema.Struct({ type: Schema.Literal("upToDate") }),
  Schema.Struct({ type: Schema.Literal("downloading"), version: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ready"), version: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
])
export type UpdateState = typeof UpdateState.Type

export const UpdateStatus = Schema.Struct({ current: Schema.String, state: UpdateState })
export type UpdateStatus = typeof UpdateStatus.Type

export const PullRequestStatus = Schema.Literals(["draft", "open", "merged", "closed"])
export type PullRequestStatus = typeof PullRequestStatus.Type

export const ChecksStatus = Schema.Literals(["passing", "failing", "pending"])
export type ChecksStatus = typeof ChecksStatus.Type

export const ReviewStatus = Schema.Literals(["approved", "changesRequested", "reviewRequired"])
export type ReviewStatus = typeof ReviewStatus.Type

export const Mergeable = Schema.Literals(["mergeable", "conflicting", "unknown"])
export type Mergeable = typeof Mergeable.Type

export const PullRequest = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  status: PullRequestStatus,
  checks: Schema.NullOr(ChecksStatus),
  review: Schema.NullOr(ReviewStatus),
  mergeable: Mergeable.pipe(Schema.withDecodingDefaultKey(Effect.succeed("unknown" as const))),
  author: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
})
export type PullRequest = typeof PullRequest.Type

export const CheckRunStatus = Schema.Literals(["passing", "failing", "pending", "skipped"])
export type CheckRunStatus = typeof CheckRunStatus.Type

export const CheckRun = Schema.Struct({
  name: Schema.String,
  status: CheckRunStatus,
  url: Schema.NullOr(Schema.String),
})
export type CheckRun = typeof CheckRun.Type

export const CommentAuthorKind = Schema.Literals(["you", "human", "bot"])
export type CommentAuthorKind = typeof CommentAuthorKind.Type

export const PullRequestComment = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  authorKind: CommentAuthorKind.pipe(Schema.withDecodingDefaultKey(Effect.succeed("human" as const))),
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
  location: Schema.NullOr(Schema.Struct({ path: Schema.String, line: Schema.NullOr(Schema.Number) })),
})
export type PullRequestComment = typeof PullRequestComment.Type

export const PullRequestDetail = Schema.Struct({
  ...PullRequest.fields,
  body: Schema.String,
  baseRef: Schema.String,
  headRef: Schema.String,
  head: Schema.String,
  checkRuns: Schema.Array(CheckRun),
  changedFiles: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  comments: Schema.Array(PullRequestComment).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})
export type PullRequestDetail = typeof PullRequestDetail.Type

export const PullRequestFileStatus = Schema.Literals(["added", "removed", "modified", "renamed", "copied"])
export type PullRequestFileStatus = typeof PullRequestFileStatus.Type

export const PullRequestFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  status: PullRequestFileStatus,
  additions: Schema.Int,
  deletions: Schema.Int,
  binary: Schema.Boolean,
  patch: Schema.String,
})
export type PullRequestFile = typeof PullRequestFile.Type

export const GuideCategory = Schema.Literals([
  "ui",
  "api",
  "core",
  "data",
  "cli",
  "security",
  "tests",
  "docs",
  "examples",
  "deps",
  "build",
  "scripts",
  "config",
  "i18n",
  "assets",
  "other",
])
export type GuideCategory = typeof GuideCategory.Type

const GuideNoteFields = {
  path: Schema.String,
  text: Schema.String,
  critical: Schema.optional(Schema.Boolean),
}

export const GuideFileNote = Schema.Struct(GuideNoteFields)
export type GuideFileNote = typeof GuideFileNote.Type

export const GuideLineNote = Schema.Struct({
  ...GuideNoteFields,
  side: Schema.Literals(["additions", "deletions"]),
  line: Schema.Number,
})
export type GuideLineNote = typeof GuideLineNote.Type

const GuideGroupFields = {
  key: Schema.String,
  label: Schema.String,
  summary: Schema.optional(Schema.String),
  category: GuideCategory,
  critical: Schema.optional(Schema.Boolean),
  filePaths: Schema.Array(Schema.String),
  fileNotes: Schema.optional(Schema.Array(GuideFileNote)),
  lineNotes: Schema.optional(Schema.Array(GuideLineNote)),
}

export const GuideGroup = Schema.Struct({
  ...GuideGroupFields,
  children: Schema.optional(Schema.Array(Schema.Struct(GuideGroupFields))),
})
export type GuideGroup = typeof GuideGroup.Type

export const PullRequestGuide = Schema.Struct({
  head: Schema.String,
  model: Schema.String,
  generatedAt: Timestamp,
  summary: Schema.String,
  groups: Schema.Array(GuideGroup),
})
export type PullRequestGuide = typeof PullRequestGuide.Type

export const PullRequestGuideJob = Schema.Union([
  Schema.Struct({ status: Schema.Literal("running"), head: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), head: Schema.String, message: Schema.String }),
])
export type PullRequestGuideJob = typeof PullRequestGuideJob.Type

export const PullRequestGuideState = Schema.Struct({
  guide: Schema.NullOr(PullRequestGuide),
  job: Schema.NullOr(PullRequestGuideJob),
})
export type PullRequestGuideState = typeof PullRequestGuideState.Type

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"])
export type MergeMethod = typeof MergeMethod.Type

export const CheckoutTarget = Schema.Union([
  Schema.TaggedStruct("branch", { ref: Schema.String }),
  Schema.TaggedStruct("pullRequest", { selector: PullRequestSelector }),
])
export type CheckoutTarget = typeof CheckoutTarget.Type

export const toCheckoutTarget = (ref: string): CheckoutTarget => {
  const selector = parsePullRequestSelector(ref)
  return selector === undefined ? { _tag: "branch", ref: ref.trim() } : { _tag: "pullRequest", selector }
}

export const WorkspaceChoice = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  target: CheckoutTarget,
})
export type WorkspaceChoice = typeof WorkspaceChoice.Type

export const OpenPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  headRefName: Schema.String,
  author: Schema.String,
  isDraft: Schema.Boolean,
})
export type OpenPullRequest = typeof OpenPullRequest.Type

export const PullRequestMatch = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  status: PullRequestStatus,
  author: Schema.String,
})
export type PullRequestMatch = typeof PullRequestMatch.Type

export const ThreadStatus = Schema.Literals(["idle", "running", "awaiting_approval", "limited", "archived"])
export type ThreadStatus = typeof ThreadStatus.Type

export const isThreadBusy = (status: ThreadStatus) => status === "running" || status === "awaiting_approval"

export const AccessMode = Schema.Literals(["supervised", "auto", "full"])
export type AccessMode = typeof AccessMode.Type

export const ToolCallStatus = Schema.Literals(["running", "done", "error"])
export type ToolCallStatus = typeof ToolCallStatus.Type

export const PickedElement = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  selector: Schema.String.check(Schema.isMaxLength(1000)),
  html: Schema.String.check(Schema.isMaxLength(4000)),
  text: Schema.String.check(Schema.isMaxLength(500)),
  components: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(5)),
})
export type PickedElement = typeof PickedElement.Type

export const Attachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  mime: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  bytes: Schema.Number,
  element: Schema.optional(PickedElement),
  deviceElement: Schema.optional(PickedDeviceElement),
})
export type Attachment = typeof Attachment.Type

export const QueuedMessage = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
})
export type QueuedMessage = typeof QueuedMessage.Type

export const Thread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  worktreeId: Schema.NullOr(Schema.String),
  title: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
  fastMode: Schema.Boolean,
  userSkills: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  accessMode: AccessMode,
  accountId: Schema.NullOr(Schema.String),
  providerSessionId: Schema.NullOr(Schema.String),
  forkedFrom: Schema.NullOr(ForkPoint).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  status: ThreadStatus,
  usageLimit: Schema.NullOr(UsageLimit),
  sortIndex: Schema.Number,
  pinnedAt: Schema.NullOr(Timestamp),
  snoozedUntil: Schema.NullOr(Timestamp).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  queue: Schema.Array(QueuedMessage),
  createdBy: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Thread = typeof Thread.Type

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
    parentCallId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("file_change"), path: Schema.String, diff: Schema.String }),
  Schema.Struct({ type: Schema.Literal("attachment"), attachment: Attachment }),
  Schema.Struct({ type: Schema.Literal("questions"), text: Schema.String, questions: Schema.Array(Question) }),
  Schema.Struct({ type: Schema.Literal("compaction"), compaction: Compaction }),
  Schema.Struct({ type: Schema.Literal("agent_switch"), from: ProviderId, to: ProviderId }),
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
  forkPoint: Schema.NullOr(ForkPoint).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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
  "github-dark",
  "github-light",
  "one-dark-pro",
  "dracula",
  "material-theme",
  "pinky",
])
export type ThemeId = typeof ThemeId.Type

export const Appearance = Schema.Struct({
  theme: ThemeId,
  fontSize: Schema.Int.check(Schema.isBetween({ minimum: 12, maximum: 20 })),
  uiFont: Schema.NullOr(Schema.String),
  monoFont: Schema.NullOr(Schema.String),
  contrast: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
})
export type Appearance = typeof Appearance.Type

export const ThreadAlert = Schema.Literals(["completed", "needsInput", "failed"])
export type ThreadAlert = typeof ThreadAlert.Type

export const NotificationSettings = Schema.Struct({
  completed: Schema.Boolean,
  needsInput: Schema.Boolean,
  failed: Schema.Boolean,
  sound: Schema.Boolean,
})
export type NotificationSettings = typeof NotificationSettings.Type

export const NotificationPermission = Schema.Literals(["granted", "denied", "notDetermined", "unknown"])
export type NotificationPermission = typeof NotificationPermission.Type

export const PermissionRequestOutcome = Schema.Literals(["shown", "refused", "noAnswer"])
export type PermissionRequestOutcome = typeof PermissionRequestOutcome.Type

export const ArchiveSettings = Schema.Struct({
  whenMerged: Schema.Boolean,
  removeWorktree: Schema.Boolean,
})
export type ArchiveSettings = typeof ArchiveSettings.Type

export const VmProvider = Schema.Literals(["sbx", "boat"])
export type VmProvider = typeof VmProvider.Type

export const BoatVmSize = Schema.Literals(["small", "default", "large", "xlarge"])
export type BoatVmSize = typeof BoatVmSize.Type

export const ExperimentalSettings = Schema.Struct({
  tinyVm: Schema.Boolean,
  tinyVmProvider: VmProvider.pipe(Schema.withDecodingDefaultKey(Effect.succeed("sbx" as const))),
  tinyVmBoatSize: BoatVmSize.pipe(Schema.withDecodingDefaultKey(Effect.succeed("default" as const))),
  tinyVmTemplate: Schema.String,
  tinyVmProfile: Schema.Boolean,
  tinyVmPasskeys: Schema.Boolean,
  tinyVmEnv: Schema.Record(Schema.String, Schema.String),
  tinyVmSetupScript: Schema.String,
  devices: Schema.Boolean,
})
export type ExperimentalSettings = typeof ExperimentalSettings.Type

export const OpenerId = Schema.Literals([
  "vscode",
  "cursor",
  "windsurf",
  "zed",
  "sublime",
  "xcode",
  "terminal",
  "iterm",
  "ghostty",
  "warp",
])
export type OpenerId = typeof OpenerId.Type

export const Opener = Schema.Struct({
  id: OpenerId,
  name: Schema.String,
  opensFiles: Schema.Boolean,
  icon: Schema.NullOr(Schema.String),
})
export type Opener = typeof Opener.Type

export const SidebarGroup = Schema.Struct({ id: Schema.String, name: Schema.String, collapsed: Schema.Boolean })
export type SidebarGroup = typeof SidebarGroup.Type

export const SidebarGroups = Schema.Struct({
  groups: Schema.Array(SidebarGroup),
  groupOf: Schema.Record(Schema.String, Schema.String),
})
export type SidebarGroups = typeof SidebarGroups.Type

export const ClientSettings = Schema.Struct({
  locale: Locale,
  openWith: Schema.NullOr(OpenerId),
  keybindings: Schema.Record(Schema.String, Schema.String),
  appearance: Appearance,
  notifications: NotificationSettings,
  sidebarGroups: SidebarGroups,
})
export type ClientSettings = typeof ClientSettings.Type

export const defaultClientSettings: ClientSettings = {
  locale: "en",
  openWith: null,
  keybindings: {},
  appearance: { theme: "system", fontSize: 16, uiFont: null, monoFont: null, contrast: 0 },
  notifications: { completed: true, needsInput: true, failed: true, sound: true },
  sidebarGroups: { groups: [], groupOf: {} },
}

// FIXME: Claude Code ignores an auto-compact window outside this range
export const AUTO_COMPACT_RANGE = { minimum: 100_000, maximum: 1_000_000 } as const
const AutoCompactTokens = Schema.Int.check(Schema.isBetween(AUTO_COMPACT_RANGE))

export const BindHost = Schema.String.check(Schema.isPattern(/^(?!(?:0\.0\.0\.0|::|::0|\[::\])$)\S+$/))

const ListenPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))

export const Settings = Schema.Struct({
  defaultProvider: ProviderId,
  defaultModel: Schema.Struct({
    claude: Schema.NullOr(Schema.String),
    codex: Schema.NullOr(Schema.String),
    muse: Schema.NullOr(Schema.String),
  }),
  defaultEffort: Schema.Struct({
    claude: Schema.NullOr(Schema.String),
    codex: Schema.NullOr(Schema.String),
    muse: Schema.NullOr(Schema.String),
  }),
  defaultFastMode: Schema.Struct({ claude: Schema.Boolean, codex: Schema.Boolean, muse: Schema.Boolean }),
  defaultWorkspaceMode: WorkspaceChoice.fields.mode,
  modelPresets: Schema.Struct({
    claude: Schema.Array(Schema.String),
    codex: Schema.Array(Schema.String),
    muse: Schema.Array(Schema.String),
  }),
  defaultAccount: Schema.Struct({
    claude: Schema.NullOr(Schema.String),
    codex: Schema.NullOr(Schema.String),
    muse: Schema.NullOr(Schema.String),
  }),
  defaultAccountName: Schema.Struct({
    claude: Schema.NullOr(AgentProfileName),
    codex: Schema.NullOr(AgentProfileName),
    muse: Schema.NullOr(AgentProfileName),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ claude: null, codex: null, muse: null }))),
  autoCompactTokens: Schema.Struct({
    claude: Schema.NullOr(AutoCompactTokens),
    codex: Schema.NullOr(AutoCompactTokens),
    muse: Schema.NullOr(AutoCompactTokens),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ claude: null, codex: null, muse: null }))),
  automations: Schema.Struct({ bindHost: BindHost, port: ListenPort }),
  remote: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false), bindHost: Schema.NullOr(BindHost), port: ListenPort }),
    Schema.Struct({ enabled: Schema.Literal(true), bindHost: BindHost, port: ListenPort }),
  ]),
  textGenerationModel: Schema.String,
  pullRequestGuide: Schema.Struct({ model: Schema.String, effort: Schema.String }),
  defaultAccessMode: AccessMode,
  archive: ArchiveSettings,
  experimental: ExperimentalSettings,
  worktreeRoot: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\//))),
})
export type Settings = typeof Settings.Type

export const defaultSettings: Settings = {
  defaultProvider: "claude",
  defaultModel: { claude: null, codex: null, muse: null },
  defaultEffort: { claude: null, codex: null, muse: null },
  defaultFastMode: { claude: false, codex: false, muse: false },
  defaultWorkspaceMode: "local",
  modelPresets: { claude: [], codex: [], muse: [] },
  defaultAccount: { claude: null, codex: null, muse: null },
  defaultAccountName: { claude: null, codex: null, muse: null },
  autoCompactTokens: { claude: null, codex: null, muse: null },
  automations: { bindHost: "127.0.0.1", port: 48080 },
  remote: { enabled: false, bindHost: null, port: 48081 },
  textGenerationModel: "claude-sonnet-5-5",
  pullRequestGuide: { model: "claude-sonnet-5-5", effort: "high" },
  defaultAccessMode: "full",
  archive: { whenMerged: false, removeWorktree: false },
  experimental: {
    tinyVm: false,
    tinyVmProvider: "sbx",
    tinyVmBoatSize: "default",
    tinyVmTemplate: "default",
    tinyVmProfile: false,
    tinyVmPasskeys: false,
    devices: false,
    tinyVmEnv: {},
    tinyVmSetupScript: "",
  },
  worktreeRoot: null,
}

export const Machine = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  projectIds: Schema.Array(Schema.String),
})
export type Machine = typeof Machine.Type

export const Environment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  relay: Schema.NullOr(Schema.String),
  source: EntrySource,
  createdAt: Timestamp,
})
export type Environment = typeof Environment.Type

export const RelayAccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("signedOut") }),
  Schema.Struct({
    state: Schema.Literal("signedIn"),
    serviceUrl: Schema.String,
    environmentId: Schema.String,
    machines: Schema.Int,
    syncedAt: Schema.NullOr(Timestamp),
    error: Schema.NullOr(Schema.String),
  }),
])
export type RelayAccountStatus = typeof RelayAccountStatus.Type

export const EnvironmentStatus = Schema.Literals(["connecting", "connected", "offline", "unauthorized", "incompatible"])
export type EnvironmentStatus = typeof EnvironmentStatus.Type

export const Environments = Schema.Struct({
  clouds: Schema.Array(
    Schema.Struct({
      ...Environment.fields,
      status: EnvironmentStatus,
      lastSeenAt: Schema.NullOr(Timestamp),
      protocol: Schema.optional(Schema.Int),
    }),
  ),
})
export type Environments = typeof Environments.Type

export const VmControl = Schema.Literals(["agent", "user"])
export type VmControl = typeof VmControl.Type

export const VmProfile = Schema.Literals(["off", "owner", "copy"])
export type VmProfile = typeof VmProfile.Type

export const ThreadVm = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.Literal("starting") }),
  Schema.Struct({
    status: Schema.Literal("running"),
    provider: VmProvider,
    sandboxId: Schema.String,
    template: Schema.String,
    profile: VmProfile,
    control: Schema.Literal("agent"),
  }),
  Schema.Struct({
    status: Schema.Literal("running"),
    provider: VmProvider,
    sandboxId: Schema.String,
    template: Schema.String,
    profile: VmProfile,
    control: Schema.Literal("user"),
    agentWaiting: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
])
export type ThreadVm = typeof ThreadVm.Type

export const VmTemplate = Schema.Struct({
  name: Schema.String,
  cpus: Schema.Number,
  memoryMiB: Schema.Number,
})
export type VmTemplate = typeof VmTemplate.Type

export const VmHostStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("connected"),
    provider: VmProvider,
    url: Schema.String,
    sandboxes: Schema.Number,
    maxSandboxes: Schema.Number,
    templates: Schema.Array(VmTemplate),
  }),
  Schema.Struct({ status: Schema.Literal("notConfigured"), provider: VmProvider }),
  Schema.Struct({
    status: Schema.Literal("unreachable"),
    provider: VmProvider,
    url: Schema.String,
    message: Schema.String,
  }),
])
export type VmHostStatus = typeof VmHostStatus.Type

export const VmDesktopUrl = Schema.Struct({ url: Schema.String })
export type VmDesktopUrl = typeof VmDesktopUrl.Type

export const VmPasskeyKind = Schema.Literals(["get", "create"])
export type VmPasskeyKind = typeof VmPasskeyKind.Type

export const VmPasskey = Schema.Union([
  Schema.Struct({ status: Schema.Literal("off") }),
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    kind: VmPasskeyKind,
    origin: Schema.String,
    rpId: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
])
export type VmPasskey = typeof VmPasskey.Type

export const WatchEventKind = Schema.Literals([
  "checksFailed",
  "checksPassed",
  "reviewChanged",
  "conflicting",
  "mergedOrClosed",
  "commented",
])
export type WatchEventKind = typeof WatchEventKind.Type

export const allWatchEventKinds: ReadonlyArray<WatchEventKind> = [
  "checksFailed",
  "checksPassed",
  "reviewChanged",
  "conflicting",
  "mergedOrClosed",
  "commented",
]

export const PullRequestWatchSnapshot = Schema.Struct({
  status: PullRequestStatus,
  checks: Schema.NullOr(ChecksStatus),
  review: Schema.NullOr(ReviewStatus),
  mergeable: Mergeable,
  head: Schema.String,
  failingChecks: Schema.Array(Schema.String),
  comments: Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
})
export type PullRequestWatchSnapshot = typeof PullRequestWatchSnapshot.Type

export const PullRequestWatch = Schema.Struct({
  generation: Schema.String,
  events: Schema.Array(WatchEventKind),
  snapshot: Schema.NullOr(PullRequestWatchSnapshot),
  wakes: Schema.Int,
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
  watch: Schema.NullOr(PullRequestWatch),
})
export type PullRequestLink = typeof PullRequestLink.Type

export const LinearIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Struct({ name: Schema.String, type: Schema.String }),
  priority: Schema.Number,
  updatedAt: Timestamp,
})
export type LinearIssue = typeof LinearIssue.Type
export const OpenPort = Schema.Struct({
  port: Schema.Number,
  pid: Schema.Number,
  command: Schema.String,
  cwd: Schema.NullOr(Schema.String),
})
export type OpenPort = typeof OpenPort.Type

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

export const TerminalOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const TerminalAttachment = Schema.Struct({
  session: TerminalSession,
  offset: TerminalOffset,
  data: Schema.String,
})
export type TerminalAttachment = typeof TerminalAttachment.Type

export const AutomationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("webhook") }),
  Schema.Struct({
    type: Schema.Literal("github.issue"),
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
  threadId: Schema.NullOr(Schema.String),
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
  promptTemplate: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  runInWorktree: Schema.Boolean,
  branchTemplate: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  polledAt: Schema.NullOr(Timestamp),
  lastRun: Schema.NullOr(AutomationRun),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Automation = typeof Automation.Type

export const ThreadSearchHit = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  projectId: Schema.String,
  messageId: Schema.String,
  snippet: Schema.String,
  at: Timestamp,
})
export type ThreadSearchHit = typeof ThreadSearchHit.Type

export const FileSearchHit = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  text: Schema.String,
})
export type FileSearchHit = typeof FileSearchHit.Type

export const RelayStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("off") }),
  Schema.Struct({ state: Schema.Literal("linking"), url: Schema.String, userCode: Schema.String }),
  Schema.Struct({ state: Schema.Literals(["paused", "connected"]), hostname: Schema.String }),
  Schema.Struct({ state: Schema.Literal("connecting"), hostname: Schema.String, error: Schema.NullOr(Schema.String) }),
])
export type RelayStatus = typeof RelayStatus.Type

export const RemoteStatus = Schema.Struct({
  listening: Schema.Boolean,
  listenError: Schema.NullOr(Schema.String),
  connected: Schema.Int,
  relay: RelayStatus,
})
export type RemoteStatus = typeof RemoteStatus.Type

export const NetworkAddress = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
})
export type NetworkAddress = typeof NetworkAddress.Type

export const ResourceSample = Schema.Struct({
  at: Schema.Number,
  cpu: Schema.Number,
  memoryUsed: Schema.Number,
  load: Schema.NullOr(Schema.Number),
})
export type ResourceSample = typeof ResourceSample.Type

export const DiskUsage = Schema.Struct({
  path: Schema.String,
  used: Schema.Number,
  free: Schema.Number,
})
export type DiskUsage = typeof DiskUsage.Type

export const diskFullness = ({ used, free }: DiskUsage) => used / (used + free || 1)

export const MachineResources = Schema.Struct({
  cpuCount: Schema.Int,
  memoryTotal: Schema.Number,
  samples: Schema.Array(ResourceSample),
  disks: Schema.Array(DiskUsage),
})
export type MachineResources = typeof MachineResources.Type

export const RemotePairing = Schema.Struct({
  hosts: Schema.NonEmptyArray(Schema.String),
  port: Schema.Int,
  token: Schema.String,
  relay: Schema.NullOr(Schema.String),
})
export type RemotePairing = typeof RemotePairing.Type
