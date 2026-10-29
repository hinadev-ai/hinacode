import { Schema, Struct } from "effect"
import {
  AccountLimits,
  AccountProviderId,
  AgentAccount,
  AgentCommand,
  AgentEvent,
  AgentProfile,
  AgentProfileName,
  AgentConfigDir,
  AgentUpdate,
  AgentBinary,
  ApprovalDecision,
  ApprovalRequest,
  ModelInfo,
  ProviderId,
  Subagent,
  BackgroundTask,
  ContextBreakdown,
  QuestionAnswers,
  QuestionRequest,
  SecretRequest,
  ThreadUsage,
  UpdatableProviderId,
} from "./agent.ts"
import {
  AccessMode,
  ClientSettings,
  Environment,
  Environments,
  EnvironmentStatus,
  RelayAccountStatus,
  Attachment,
  QueuedMessage,
  Automation,
  Changes,
  ChangesScope,
  AutomationRun,
  FileSearchHit,
  AutomationTrigger,
  FsEntry,
  FsFileContent,
  CommitDiff,
  GitCommit,
  Machine,
  MergeMethod,
  NotificationPermission,
  PermissionRequestOutcome,
  Message,
  OpenPort,
  Opener,
  OpenerId,
  Project,
  GitHubAuth,
  GitHubRateLimit,
  PullRequest,
  PullRequestDetail,
  PullRequestFile,
  PullRequestGuideState,
  PullRequestLink,
  LinearIssue,
  MachineResources,
  NetworkAddress,
  RemotePairing,
  RemoteStatus,
  Settings,
  TerminalAttachment,
  TerminalOffset,
  TerminalSession,
  Thread,
  Timestamp,
  ThreadSearchHit,
  UpdateStatus,
  ThreadStatus,
  ThreadVm,
  VmControl,
  VmHostStatus,
  VmPasskey,
  Worktree,
  WorktreeCheckout,
  WorkspaceChoice,
  OpenPullRequest,
  PullRequestMatch,
} from "./domain.ts"
import { GitHubRepository } from "./github.ts"
import { PendingLink, RelayHost } from "./relayMachines.ts"
import { BrowserCommand, BrowserSession, BrowserSnapshot, BrowserUrl, BrowserViewport } from "./browser.ts"
import {
  DeviceCommand,
  SimulatorModelId,
  DeviceControl,
  DeviceFrame,
  DeviceHost,
  DeviceId,
  PickedDeviceElement,
  ThreadDevice,
  ThreadDevices,
} from "./device.ts"

const AutomationInput = Schema.Struct({
  projectId: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  promptTemplate: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  runInWorktree: Schema.Boolean,
  branchTemplate: Schema.NullOr(Schema.String),
})
export type AutomationInput = typeof AutomationInput.Type

const TerminalSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))

const rpc = <Req extends Schema.Top, Res extends Schema.Top>(request: Req, response: Res) => ({ request, response })

/** Every renderer -> main call. Both sides decode what they receive with these schemas. */
export const RpcMethods = {
  "devices.list": rpc(Schema.Struct({ threadId: Schema.String }), DeviceHost),
  "device.get": rpc(Schema.Struct({ threadId: Schema.String }), ThreadDevices),
  /** Streams an existing device in the thread next to its others, booting it when it is shut down. */
  "device.attach": rpc(Schema.Struct({ threadId: Schema.String, deviceId: DeviceId }), ThreadDevice),
  /**
   * Creates a simulator for the thread, slims it when simslim is installed, and boots it. Archiving deletes it.
   * Without `model` it picks the newest plain iPhone.
   */
  "device.create": rpc(
    Schema.Struct({ threadId: Schema.String, model: Schema.optional(SimulatorModelId) }),
    ThreadDevice,
  ),
  /**
   * Stops streaming a device. Deletes it only when HinaCode created it for this thread.
   * A null id dismisses a simulator that failed before it was created.
   */
  "device.detach": rpc(Schema.Struct({ threadId: Schema.String, deviceId: Schema.NullOr(DeviceId) }), Schema.Void),
  /** Stops and deletes a device on the thread's machine, whoever created it. Refused while another thread uses it. */
  "device.delete": rpc(Schema.Struct({ threadId: Schema.String, deviceId: DeviceId }), Schema.Void),
  /** The newest frame after `after`, waiting up to a second for one. Each call renews the stream's lease. */
  "device.frame": rpc(
    Schema.Struct({
      threadId: Schema.String,
      deviceId: DeviceId,
      after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      visible: Schema.Boolean,
    }),
    Schema.Struct({ frame: Schema.NullOr(DeviceFrame) }),
  ),
  "device.command": rpc(
    Schema.Struct({
      threadId: Schema.String,
      deviceId: DeviceId,
      commands: Schema.Array(DeviceCommand).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    }),
    Schema.Void,
  ),
  "device.control": rpc(
    Schema.Struct({ threadId: Schema.String, deviceId: DeviceId, control: DeviceControl }),
    ThreadDevice,
  ),
  /** The smallest accessibility element at the point, given as fractions of the screen. The view crops it from its own frame. */
  "device.pick": rpc(
    Schema.Struct({
      threadId: Schema.String,
      deviceId: DeviceId,
      x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
    Schema.NullOr(PickedDeviceElement),
  ),
  "app.ready": rpc(Schema.Void, Schema.Void),
  "app.focus": rpc(Schema.Void, Schema.Void),
  /** The number on the Dock icon. Zero clears it. */
  "app.setBadgeCount": rpc(Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }), Schema.Void),
  /** The appearance of native UI (glass, menus, dialogs), which follows the app theme rather than the system. */
  "app.setColorScheme": rpc(Schema.Literals(["dark", "light", "system"]), Schema.Void),
  "browser.open": rpc(
    Schema.Struct({ threadId: Schema.String, url: BrowserUrl, ...BrowserViewport.fields }),
    Schema.Struct({ sessionId: Schema.String }),
  ),
  "browser.command": rpc(
    Schema.Struct({
      ...BrowserSession.fields,
      commands: Schema.Array(BrowserCommand).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    }),
    Schema.Void,
  ),
  "browser.frame": rpc(
    Schema.Struct({
      ...BrowserSession.fields,
      after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      visible: Schema.Boolean,
    }),
    BrowserSnapshot,
  ),
  "browser.close": rpc(BrowserSession, Schema.Void),
  "projects.list": rpc(Schema.Void, Schema.Array(Project)),
  "projects.create": rpc(
    Schema.Struct({
      name: Schema.String,
      rootPath: Schema.String,
      setupScript: Schema.NullOr(Schema.String),
    }),
    Project,
  ),
  "projects.clone": rpc(
    Schema.Struct({
      repository: GitHubRepository,
      rootPath: Schema.String,
      name: Schema.String,
      setupScript: Schema.NullOr(Schema.String),
    }),
    Project,
  ),
  "projects.update": rpc(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      rootPath: Schema.optional(Schema.String),
      setupScript: Schema.optional(Schema.NullOr(Schema.String)),
      linearReview: Schema.optional(Schema.Boolean),
    }),
    Project,
  ),
  "projects.delete": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),

  "threads.list": rpc(Schema.Void, Schema.Array(Thread)),
  /** An empty thread with a placeholder title and the default agent, configured in the composer until its first message. */
  "threads.create": rpc(Schema.Struct({ projectId: Schema.String }), Thread),
  "threads.update": rpc(
    Schema.Struct({
      id: Schema.String,
      title: Schema.optional(Schema.String),
      /** Only before the first message. Switches to the agent's default model unless `model` is given. */
      provider: Schema.optional(ProviderId),
      model: Schema.optional(Schema.String),
      /** Null goes back to the model's default effort. */
      effort: Schema.optional(Schema.NullOr(Schema.String)),
      fastMode: Schema.optional(Schema.Boolean),
      userSkills: Schema.optional(Schema.Boolean),
      accessMode: Schema.optional(AccessMode),
      status: Schema.optional(ThreadStatus),
      sortIndex: Schema.optional(Schema.Number),
      pinned: Schema.optional(Schema.Boolean),
      /** Null wakes the thread. */
      snoozedUntil: Schema.optional(Schema.NullOr(Timestamp)),
    }),
    Thread,
  ),
  "threads.delete": rpc(
    Schema.Struct({ id: Schema.String, removeWorktree: Schema.optional(Schema.Boolean) }),
    Schema.Void,
  ),
  "threads.resumeAtReset": rpc(Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }), Thread),
  /**
   * Moves the thread to another account of its agent, copying its session there first. Refused while a turn
   * runs. A limited thread goes back to idle. `resend` sends the last prompt again on the new account.
   */
  "threads.switchAccount": rpc(
    Schema.Struct({
      id: Schema.String,
      accountId: Schema.NullOr(Schema.String),
      resend: Schema.optional(Schema.Boolean),
    }),
    Thread,
  ),

  "worktrees.list": rpc(Schema.Void, Schema.Array(Worktree)),
  "worktrees.create": rpc(
    Schema.Struct({ projectId: Schema.String, branch: Schema.String, baseRef: Schema.String }),
    Worktree,
  ),
  /** `ifMerged` deletes the branch only when it is merged into the base ref; `force` always does. */
  "worktrees.remove": rpc(
    Schema.Struct({ id: Schema.String, deleteBranch: Schema.Literals(["keep", "ifMerged", "force"]) }),
    Worktree,
  ),
  /** The checkout state of every live worktree. A checkout git cannot read is left out. */
  "worktrees.checkouts": rpc(Schema.Void, Schema.Array(WorktreeCheckout)),
  "worktrees.setupLog": rpc(Schema.Struct({ id: Schema.String }), Schema.String),
  /** Kills a setup script still running; the worktree ends `failed`. */
  "worktrees.stopSetup": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),
  /** The branch's GitHub pull request via `gh`, or null when there is none. */
  "worktrees.pullRequest": rpc(Schema.Struct({ id: Schema.String }), Schema.NullOr(PullRequest)),
  /** Null when the scope has no base: the thread has no live worktree, or no turn started in a git checkout. */
  "threads.changes": rpc(Schema.Struct({ threadId: Schema.String, scope: ChangesScope }), Schema.NullOr(Changes)),
  /** Archives the thread, removing its worktree when `Settings.archive.removeWorktree` is on. */
  /** A new thread that goes on from the turn `messageId` ended, in the same workspace. */
  "threads.fork": rpc(Schema.Struct({ threadId: Schema.String, messageId: Schema.String }), Thread),
  "threads.archive": rpc(Schema.Struct({ threadId: Schema.String }), Thread),
  /** Brings an archived thread back as idle. A removed worktree stays removed. */
  "threads.unarchive": rpc(Schema.Struct({ threadId: Schema.String }), Thread),
  "projects.currentBranch": rpc(Schema.Struct({ id: Schema.String }), Schema.String),
  /** The ref a new worktree forks from unless the user picks another: `origin/<default branch>`, else `main`. */
  "projects.defaultBranch": rpc(Schema.Struct({ id: Schema.String }), Schema.String),
  /** Local branches, most recently committed first, then `origin/*` branches that have no local copy. */
  "projects.branches": rpc(Schema.Struct({ id: Schema.String }), Schema.Array(Schema.String)),
  /** Open pull requests of the project's repository, newest first. Empty when `gh` is missing or signed out. */
  "projects.pullRequests": rpc(Schema.Struct({ id: Schema.String }), Schema.Array(OpenPullRequest)),
  /**
   * Pull requests of the project's GitHub repository in any state, best match first, or the newest for an empty query.
   * Empty when the project is not on GitHub or `gh` is missing or signed out.
   */
  "projects.searchPullRequests": rpc(
    Schema.Struct({ id: Schema.String, query: Schema.String }),
    Schema.Array(PullRequestMatch),
  ),
  /** Fetches `origin`, so the branch picker and a new worktree's default base are current. */
  "projects.fetch": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),
  /** The project's own favicon as a data URL, or null when it has none. */
  "projects.icon": rpc(Schema.Struct({ id: Schema.String }), Schema.NullOr(Schema.String)),
  /**
   * Commits on every branch of the checkout at `root`, newest first in topological order. `root` must be
   * a project root or a live worktree path.
   */
  "git.log": rpc(
    Schema.Struct({
      root: Schema.String,
      limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
    }),
    Schema.Array(GitCommit),
  ),
  /** One commit's diff against its first parent. Hex only, so a hash can never be read as an option. */
  "git.show": rpc(
    Schema.Struct({ root: Schema.String, hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,64}$/)) }),
    CommitDiff,
  ),
  /** Shows the path in the OS file manager. */
  "shell.reveal": rpc(Schema.Struct({ path: Schema.String }), Schema.Void),
  /** The apps on this desktop that "Open with" can launch. */
  "shell.openers": rpc(Schema.Void, Schema.Array(Opener)),
  /** Opens a folder or file in the app. Fails when the app is not installed. */
  "shell.openWith": rpc(Schema.Struct({ path: Schema.String, opener: OpenerId }), Schema.Void),

  "settings.get": rpc(Schema.Void, Settings),
  "notifications.permission": rpc(Schema.Void, NotificationPermission),
  "notifications.askPermission": rpc(
    Schema.Struct({ title: Schema.String, body: Schema.String }),
    PermissionRequestOutcome,
  ),
  "settings.set": rpc(Settings.mapFields(Struct.map(Schema.optional)), Settings),
  "clientSettings.get": rpc(Schema.Void, ClientSettings),
  "clientSettings.set": rpc(ClientSettings.mapFields(Struct.map(Schema.optional)), ClientSettings),

  "environments.list": rpc(Schema.Void, Environments),
  /** Each machine answers for itself, so the gathered list says which machine holds which project. */
  "machines.list": rpc(Schema.Void, Schema.Array(Machine)),
  /**
   * Connects once with the pairing URL's token before saving, so a typo or a rotated token fails here. Pairing a
   * cloud that is already listed updates its address and token instead of adding it again.
   */
  "environments.add": rpc(Schema.Struct({ name: Schema.String, pairingUrl: Schema.String }), Environment),
  /** Forgets the cloud and its token. Its projects and threads stay on the cloud. */
  "environments.remove": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),
  /** Dials an offline or incompatible cloud now instead of after its backoff. Calls waiting for it keep waiting. */
  "environments.reconnect": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),
  "relayAccount.status": rpc(Schema.Void, RelayAccountStatus),
  /** Lists the relay's machines with the owner token, and keeps it only when the relay accepts it. */
  "relayAccount.signIn": rpc(Schema.Struct({ ownerToken: Schema.String }), RelayAccountStatus),
  /** Forgets the owner token and every environment the relay added. */
  "relayAccount.signOut": rpc(Schema.Void, RelayAccountStatus),
  /** Never fails: why a sync failed is the status's `error`. */
  "relayAccount.sync": rpc(Schema.Void, RelayAccountStatus),
  /** Every machine linked to the relay, for the owner to manage. */
  "relayAccount.machines": rpc(Schema.Void, Schema.Array(RelayHost)),
  /** Show on my devices. Syncs, then answers the fresh list. */
  "relayAccount.setShown": rpc(Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }), Schema.Array(RelayHost)),
  /** Deletes another machine's tunnel and hostname. Refuses this desktop's own. Syncs, then answers the fresh list. */
  "relayAccount.removeMachine": rpc(Schema.Struct({ id: Schema.String }), Schema.Array(RelayHost)),
  /** The machine waiting on a link code that `hinacode serve --relay on` printed. */
  "relayAccount.pendingLink": rpc(Schema.Struct({ userCode: Schema.String }), PendingLink),
  /** Waits for the machine to publish its pairing and syncs, then answers the fresh list. */
  "relayAccount.approveLink": rpc(Schema.Struct({ userCode: Schema.String }), Schema.Array(RelayHost)),

  "models.list": rpc(Schema.Struct({ provider: ProviderId }), Schema.Array(ModelInfo)),
  /** Who the account is signed in as. `accountId` null is the CLI's own login. */
  "agents.account": rpc(Schema.Struct({ provider: ProviderId, accountId: Schema.NullOr(Schema.String) }), AgentAccount),
  /** Agent CLIs on this desktop's PATH with a newer release, checked now. */
  "agents.updates": rpc(Schema.Void, Schema.Array(AgentUpdate)),
  /** Runs the agent CLI's own `update` and returns the version it installed. */
  "agents.update": rpc(Schema.Struct({ provider: UpdatableProviderId }), Schema.String),
  /** Plan limits of every signed-in account, read at most once a minute per account. */
  "limits.list": rpc(Schema.Void, Schema.Array(AccountLimits)),
  "accounts.list": rpc(Schema.Void, Schema.Array(AgentProfile)),
  "accounts.create": rpc(
    Schema.Struct({
      provider: AccountProviderId,
      name: AgentProfileName,
      configDir: AgentConfigDir,
      binary: AgentBinary,
    }),
    AgentProfile,
  ),
  "accounts.rename": rpc(Schema.Struct({ id: Schema.String, name: AgentProfileName }), AgentProfile),
  /** Refused while any thread uses the account. Its config directory stays on disk. */
  "accounts.delete": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),
  /** What the thread's agent can complete in the composer, as seen from the thread's working directory. */
  "commands.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(AgentCommand)),
  /** Paths relative to the thread's working directory that git tracks or would track, for `@` mentions. */
  "files.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(Schema.String)),
  /** Messages across every thread containing `query`, newest first. */
  "search.threads": rpc(
    Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) }),
    Schema.Array(ThreadSearchHit),
  ),
  /** Lines containing `query` in the thread's active workspace, found with ripgrep. */
  "search.files": rpc(
    Schema.Struct({ threadId: Schema.String, query: Schema.String, limit: Schema.optional(Schema.Number) }),
    Schema.Array(FileSearchHit),
  ),

  /**
   * One level of a folder under `root`, folders first. `root` must be a project root or a live worktree
   * path, and `path` is relative to it ("" for the root itself).
   */
  "fs.list": rpc(Schema.Struct({ root: Schema.String, path: Schema.String }), Schema.Array(FsEntry)),
  /** Up to the first 1 MB of a file under `root`, with the same checks as `fs.list`. */
  "fs.read": rpc(Schema.Struct({ root: Schema.String, path: Schema.String }), FsFileContent),
  /** A file as a data URL, so a desktop can preview a cloud's media and HTML. Checked like `fs.read`. A file too large for one remote frame fails. */
  "fs.preview": rpc(
    Schema.Struct({ root: Schema.String, path: Schema.String }),
    Schema.Struct({ dataUrl: Schema.String }),
  ),
  /**
   * Replaces the text of the existing file `path` under `root`, with the same checks as `fs.read`. `expected` is the
   * text the edit started from; the write fails with `FsWriteConflict` when the file no longer holds it. `null`
   * overwrites whatever is there.
   */
  "fs.write": rpc(
    Schema.Struct({
      root: Schema.String,
      path: Schema.String,
      content: Schema.String,
      expected: Schema.NullOr(Schema.String),
    }),
    Schema.Void,
  ),
  /** Replaces the folders under `root` that push `fs.changed`. An empty `paths` stops watching the root. */
  "fs.watch": rpc(Schema.Struct({ root: Schema.String, paths: Schema.Array(Schema.String) }), Schema.Void),

  /** Opens the native folder picker. Null when the user cancels. */
  "dialog.pickFolder": rpc(Schema.Void, Schema.NullOr(Schema.String)),

  /** The running version and what the updater is doing. */
  "updates.status": rpc(Schema.Void, UpdateStatus),
  /** Checks for a release now and downloads it. Does nothing while a check or download runs or one is ready. */
  "updates.check": rpc(Schema.Void, Schema.Void),
  /** Quits, installs the downloaded release and relaunches. */
  "updates.install": rpc(Schema.Void, Schema.Void),

  /**
   * The thread's live transcript and pending approvals, questions and secret requests as of push `seq`: it
   * reflects every transcript push up to and including `seq`, and none after. `compact` keeps only what the
   * phone shows, see `compactMessage`. `page` returns only the newest messages, or those older than `page.before`,
   * up to `TRANSCRIPT_PAGE_BYTES`, with `hasEarlier` set; servers that predate it send every message without it.
   */
  "threads.transcript": rpc(
    Schema.Struct({
      threadId: Schema.String,
      compact: Schema.optional(Schema.Boolean),
      page: Schema.optional(Schema.Struct({ before: Schema.optional(Schema.String) })),
    }),
    Schema.Struct({
      messages: Schema.Array(Message),
      hasEarlier: Schema.optional(Schema.Boolean),
      approvals: Schema.Array(ApprovalRequest),
      questions: Schema.Array(QuestionRequest),
      secretRequests: Schema.Array(SecretRequest),
      seq: Schema.Number,
    }),
  ),
  /**
   * Starts a turn and returns once it is running; progress arrives as `message.created` and `thread.event`.
   * `workspace` is only accepted with the first message, and is set up before the turn starts.
   */
  "threads.send": rpc(
    Schema.Struct({
      threadId: Schema.String,
      prompt: Schema.String,
      attachments: Schema.optional(Schema.Array(Attachment)),
      workspace: Schema.optional(WorkspaceChoice),
    }),
    Schema.Void,
  ),
  "threads.interrupt": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Void),
  "approvals.respond": rpc(Schema.Struct({ requestId: Schema.String, decision: ApprovalDecision }), Schema.Void),
  "questions.respond": rpc(Schema.Struct({ requestId: Schema.String, answers: QuestionAnswers }), Schema.Void),
  /** Secrets never cross back to the renderer; it can only ask whether one is set. */
  "secrets.has": rpc(Schema.Struct({ name: Schema.String }), Schema.Boolean),
  "secrets.set": rpc(Schema.Struct({ name: Schema.String, value: Schema.String }), Schema.Void),
  "secrets.clear": rpc(Schema.Struct({ name: Schema.String }), Schema.Void),
  /** Sub-agents the thread's agent spawned since the app started, newest first. */
  "subagents.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(Subagent)),
  /** Stops one running sub-agent by its `Subagent.id`. The turn that spawned it keeps going. */
  "subagents.stop": rpc(Schema.Struct({ threadId: Schema.String, subagentId: Schema.String }), Schema.Void),
  /** Background tasks the thread's agent has running now, oldest first. */
  "backgroundTasks.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(BackgroundTask)),
  "backgroundTasks.stop": rpc(Schema.Struct({ threadId: Schema.String, taskId: Schema.String }), Schema.Void),
  /** Tokens the thread spent, read from its agent's transcripts. Null before the first turn or once they are gone. */
  "threads.usage": rpc(Schema.Struct({ threadId: Schema.String }), Schema.NullOr(ThreadUsage)),
  /** What fills the context window of the thread's open agent session. Null when none is open. */
  "threads.contextBreakdown": rpc(Schema.Struct({ threadId: Schema.String }), Schema.NullOr(ContextBreakdown)),
  /** Answers an agent's `request_secret`. `value: null` declines; otherwise it is stored under the request's name. */
  "secrets.respond": rpc(Schema.Struct({ requestId: Schema.String, value: Schema.NullOr(Schema.String) }), Schema.Void),
  "pullRequests.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(PullRequestLink)),
  "pullRequests.all": rpc(Schema.Void, Schema.Array(PullRequestLink)),
  "pullRequests.unlink": rpc(Schema.Struct({ threadId: Schema.String, url: Schema.String }), Schema.Void),
  /** Pushes the thread's worktree branch, opens a pull request against its base ref, and links it. Returns the URL. */
  "pullRequests.create": rpc(Schema.Struct({ threadId: Schema.String }), Schema.String),
  /**
   * Watches the pull request for the thread, linking it first when needed. Changes wake the thread
   * until the watch stops, the pull request merges or closes, or it gives up. Watches for every event kind.
   */
  "pullRequests.watch": rpc(Schema.Struct({ threadId: Schema.String, url: Schema.String }), PullRequestLink),
  /** Stops watching the pull request. The link itself stays. */
  "pullRequests.unwatch": rpc(Schema.Struct({ threadId: Schema.String, url: Schema.String }), Schema.Void),

  "github.auth": rpc(Schema.Void, GitHubAuth),
  "github.pullRequest": rpc(Schema.Struct({ url: Schema.String }), PullRequest),
  "github.pullRequestDetail": rpc(Schema.Struct({ url: Schema.String }), PullRequestDetail),
  "github.pullRequestFiles": rpc(Schema.Struct({ url: Schema.String }), Schema.Array(PullRequestFile)),
  "github.merge": rpc(Schema.Struct({ url: Schema.String, method: MergeMethod }), Schema.Void),
  "github.close": rpc(Schema.Struct({ url: Schema.String }), Schema.Void),
  "github.comment": rpc(Schema.Struct({ url: Schema.String, body: Schema.String }), Schema.Void),
  "pullRequestGuides.get": rpc(Schema.Struct({ url: Schema.String }), PullRequestGuideState),
  "pullRequestGuides.retry": rpc(Schema.Struct({ url: Schema.String }), Schema.Void),
  /** Open Linear issues assigned to the owner of this machine's Linear key. Empty when it has none. */
  "linear.issues": rpc(Schema.Void, Schema.Array(LinearIssue)),
  /** The GitHub repository the project's `origin` points at, or null. */
  "github.repository": rpc(Schema.Struct({ projectId: Schema.String }), Schema.NullOr(GitHubRepository)),
  /** The icon of the url's site as a data URL, or null. Main only ever GETs the origin root and the icon. */
  "links.favicon": rpc(Schema.Struct({ url: Schema.String }), Schema.NullOr(Schema.String)),
  /** The built-in MCP server connection handed to agents running in this thread. */
  "mcp.connection": rpc(
    Schema.Struct({ threadId: Schema.String }),
    Schema.Struct({ url: Schema.String, headers: Schema.Struct({ authorization: Schema.String }) }),
  ),

  "ports.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(OpenPort)),
  "ports.kill": rpc(Schema.Struct({ pid: Schema.Number }), Schema.Void),

  /** Starts a login shell in the thread's worktree, or in the project root when it has none. */
  "terminal.open": rpc(
    Schema.Struct({ threadId: Schema.String, cols: TerminalSize, rows: TerminalSize }),
    TerminalSession,
  ),
  /** Input for the shell. Ignored once the session has exited. */
  "terminal.write": rpc(Schema.Struct({ id: Schema.String, data: Schema.String }), Schema.Void),
  "terminal.resize": rpc(Schema.Struct({ id: Schema.String, cols: TerminalSize, rows: TerminalSize }), Schema.Void),
  /** Ends the shell if it still runs and forgets the session. */
  "terminal.close": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),
  "terminal.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(TerminalSession)),
  /**
   * Output kept since offset `since`, or the oldest kept output when it is null or older. When the answer's `offset`
   * is past `since`, output was dropped, so clear the screen before writing `data`. Pushes that overlap `data` are
   * trimmed by their own `offset`.
   */
  "terminal.attach": rpc(
    Schema.Struct({ id: Schema.String, since: Schema.NullOr(TerminalOffset) }),
    TerminalAttachment,
  ),

  "vm.get": rpc(Schema.Struct({ threadId: Schema.String }), ThreadVm),
  /**
   * Creates the thread's tiny VM unless it has one. Resolves once it runs or fails. `template` overrides the
   * configured template for this one VM.
   */
  "vm.start": rpc(Schema.Struct({ threadId: Schema.String, template: Schema.optional(Schema.String) }), ThreadVm),
  /** Destroys the thread's tiny VM. */
  "vm.stop": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Void),
  /** Hands the pointer and keyboard to the user, or back to the agent. */
  "vm.control": rpc(Schema.Struct({ threadId: Schema.String, control: VmControl }), ThreadVm),
  "vm.host": rpc(Schema.Void, VmHostStatus),
  /**
   * Connects the side panel to the running VM's VNC server. The server's bytes arrive as `vm.screen.data`.
   * The renderer picks `streamId`, so it can listen before the first push.
   */
  "vm.screen.open": rpc(Schema.Struct({ threadId: Schema.String, streamId: Schema.String }), Schema.Void),
  /** Bytes for the VNC server, written in call order. Ignored once the stream has closed. */
  "vm.screen.send": rpc(Schema.Struct({ streamId: Schema.String, data: Schema.Uint8Array }), Schema.Void),
  "vm.screen.close": rpc(Schema.Struct({ streamId: Schema.String }), Schema.Void),
  /**
   * Copies the files and folders at these host paths into the thread VM's `~/Downloads`. Paths stay paths, so no
   * file bytes cross rpc. Resolves with the guest path each item landed at.
   */
  "vm.files.drop": rpc(
    Schema.Struct({ threadId: Schema.String, paths: Schema.Array(Schema.String) }),
    Schema.Array(Schema.String),
  ),
  /** Saves the VM's Chromium profile to this machine now. Fails unless this VM owns the shared profile. */
  "vm.profile.save": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Void),
  /**
   * Screenshots the thread VM's screen and stages the PNG as a thread attachment on this machine. The
   * renderer reveals the returned path. Works whichever side has control.
   */
  "vm.screenshot.save": rpc(Schema.Struct({ threadId: Schema.String }), Attachment),
  "vm.passkey.get": rpc(Schema.Struct({ threadId: Schema.String }), VmPasskey),
  /**
   * Arms the thread VM's passkey relay. Copies the proxy extension into the VM, restarts its Chromium with
   * the extension, and resolves with the relay state. Idempotent while armed.
   */
  "vm.passkey.prepare": rpc(Schema.Struct({ threadId: Schema.String }), VmPasskey),
  /** Cancels the pending passkey ceremony, if any. The VM page sees the error a dismissed prompt gives. */
  "vm.passkey.cancel": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Void),

  /** Adds input to the running turn; starts a turn like `threads.send` when none is running. */
  "threads.steer": rpc(
    Schema.Struct({
      threadId: Schema.String,
      text: Schema.String,
      attachments: Schema.optional(Schema.Array(Attachment)),
    }),
    Schema.Void,
  ),

  /** Holds the message until the running turn completes; sends it like `threads.send` when none is running. */
  "threads.queue": rpc(
    Schema.Struct({
      threadId: Schema.String,
      text: Schema.String,
      attachments: Schema.optional(Schema.Array(Attachment)),
    }),
    Schema.Void,
  ),
  /** Takes a message out of the queue and returns it. Null when it already left, e.g. because its turn started. */
  "threads.unqueue": rpc(Schema.Struct({ threadId: Schema.String, id: Schema.String }), Schema.NullOr(QueuedMessage)),

  /** Copies a file (`path`) or decodes a pasted image (`dataUrl`) into the thread's attachments dir. */
  "attachments.stage": rpc(
    Schema.Struct({
      threadId: Schema.String,
      source: Schema.Union([
        Schema.Struct({ path: Schema.String }),
        Schema.Struct({ dataUrl: Schema.String, name: Schema.String }),
      ]),
    }),
    Attachment,
  ),
  /** A staged attachment's bytes, for a desktop showing a cloud thread. Refuses paths outside the attachments dir. */
  "attachments.read": rpc(Schema.Struct({ path: Schema.String }), Schema.Struct({ dataUrl: Schema.String })),
  /** Opens the native multi-file picker. Empty when the user cancels. */
  "dialog.pickFiles": rpc(Schema.Void, Schema.Array(Schema.String)),

  "automations.list": rpc(Schema.Void, Schema.Array(Automation)),
  /** `secret` is the webhook HMAC secret, returned only here; null for polling triggers. */
  "automations.create": rpc(
    AutomationInput,
    Schema.Struct({ automation: Automation, secret: Schema.NullOr(Schema.String) }),
  ),
  /** The trigger type is fixed at creation; its other fields can change. */
  "automations.update": rpc(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      enabled: Schema.optional(Schema.Boolean),
      trigger: Schema.optional(AutomationTrigger),
      promptTemplate: Schema.optional(Schema.String),
      provider: Schema.optional(ProviderId),
      model: Schema.optional(Schema.String),
      runInWorktree: Schema.optional(Schema.Boolean),
      branchTemplate: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    Automation,
  ),
  "automations.delete": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),
  /** Runs the automation as if `payload` had arrived, bypassing dedup. */
  "automations.runNow": rpc(Schema.Struct({ id: Schema.String, payload: Schema.Unknown }), AutomationRun),
  /** Newest first. */
  "automations.runs": rpc(
    Schema.Struct({ id: Schema.String, limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })) }),
    Schema.Array(AutomationRun),
  ),
  /** IPv4 addresses the remote and webhook listeners can bind to, Tailscale first. */
  "network.addresses": rpc(Schema.Void, Schema.Array(NetworkAddress)),
  "system.resources": rpc(Schema.Void, MachineResources),
  /** `listenError` is set when the webhook listener could not bind, e.g. the port is taken. */
  "remote.status": rpc(Schema.Void, RemoteStatus),
  "remote.pairing": rpc(Schema.Void, RemotePairing),
  /** Replaces the access token and disconnects every phone. */
  "remote.rotateToken": rpc(Schema.Void, RemotePairing),
  /**
   * Links this machine to a HinaCode account, opening the approval page in the browser, and starts its tunnel.
   * Answers once the tunnel exists, or fails when the link expires. A linked machine only refreshes its tunnel.
   */
  "remote.setupRelay": rpc(Schema.Void, RemotePairing),
  /** Unlinks this machine, which deletes its tunnel and hostname. Also cancels a link waiting for approval. */
  "remote.removeRelay": rpc(Schema.Void, RemotePairing),
  "automations.webhookUrl": rpc(
    Schema.Struct({ id: Schema.String }),
    Schema.Struct({ url: Schema.String, listenError: Schema.NullOr(Schema.String) }),
  ),
}

export type RpcMethod = keyof typeof RpcMethods

/** Reads rerun after a reconnect; mutations retain one call key for the whole action. */
export const methodKind: Record<RpcMethod, "read" | "mutation"> = {
  "browser.open": "mutation",
  "browser.command": "mutation",
  "browser.frame": "read",
  "browser.close": "mutation",
  "devices.list": "read",
  "device.get": "read",
  "device.attach": "mutation",
  "device.create": "mutation",
  "device.detach": "mutation",
  "device.delete": "mutation",
  "device.frame": "read",
  "device.command": "mutation",
  "device.control": "mutation",
  "device.pick": "mutation",
  "app.ready": "mutation",
  "app.focus": "mutation",
  "app.setBadgeCount": "mutation",
  "app.setColorScheme": "mutation",
  "projects.list": "read",
  "projects.create": "mutation",
  "projects.clone": "mutation",
  "projects.update": "mutation",
  "projects.delete": "mutation",
  "threads.list": "read",
  "threads.create": "mutation",
  "threads.update": "mutation",
  "threads.delete": "mutation",
  "threads.resumeAtReset": "mutation",
  "threads.switchAccount": "mutation",
  "worktrees.list": "read",
  "worktrees.create": "mutation",
  "worktrees.remove": "mutation",
  "worktrees.checkouts": "read",
  "worktrees.setupLog": "read",
  "worktrees.stopSetup": "mutation",
  "worktrees.pullRequest": "read",
  "threads.changes": "read",
  "threads.fork": "mutation",
  "threads.archive": "mutation",
  "threads.unarchive": "mutation",
  "projects.currentBranch": "read",
  "projects.defaultBranch": "read",
  "projects.branches": "read",
  "projects.pullRequests": "read",
  "projects.searchPullRequests": "read",
  "projects.fetch": "mutation",
  "projects.icon": "read",
  "git.log": "read",
  "git.show": "read",
  "shell.reveal": "mutation",
  "shell.openers": "read",
  "shell.openWith": "mutation",
  "settings.get": "read",
  "notifications.permission": "read",
  "notifications.askPermission": "mutation",
  "settings.set": "mutation",
  "clientSettings.get": "read",
  "clientSettings.set": "mutation",
  "environments.list": "read",
  "machines.list": "read",
  "environments.add": "mutation",
  "environments.remove": "mutation",
  "environments.reconnect": "mutation",
  "relayAccount.status": "read",
  "relayAccount.signIn": "mutation",
  "relayAccount.signOut": "mutation",
  "relayAccount.sync": "mutation",
  "relayAccount.machines": "read",
  "relayAccount.setShown": "mutation",
  "relayAccount.removeMachine": "mutation",
  "relayAccount.pendingLink": "read",
  "relayAccount.approveLink": "mutation",
  "models.list": "read",
  "agents.account": "read",
  "agents.updates": "read",
  "agents.update": "mutation",
  "limits.list": "read",
  "accounts.list": "read",
  "accounts.create": "mutation",
  "accounts.rename": "mutation",
  "accounts.delete": "mutation",
  "commands.list": "read",
  "files.list": "read",
  "search.threads": "read",
  "search.files": "read",
  "fs.list": "read",
  "fs.read": "read",
  "fs.preview": "read",
  "fs.write": "mutation",
  "fs.watch": "mutation",
  "dialog.pickFolder": "mutation",
  "updates.status": "read",
  "updates.check": "mutation",
  "updates.install": "mutation",
  "threads.transcript": "read",
  "threads.send": "mutation",
  "threads.queue": "mutation",
  "threads.unqueue": "mutation",
  "threads.interrupt": "mutation",
  "approvals.respond": "mutation",
  "questions.respond": "mutation",
  "secrets.has": "read",
  "secrets.set": "mutation",
  "secrets.clear": "mutation",
  "subagents.list": "read",
  "subagents.stop": "mutation",
  "backgroundTasks.list": "read",
  "backgroundTasks.stop": "mutation",
  "threads.usage": "read",
  "threads.contextBreakdown": "read",
  "secrets.respond": "mutation",
  "pullRequests.list": "read",
  "pullRequests.all": "read",
  "pullRequests.unlink": "mutation",
  "pullRequests.create": "mutation",
  "pullRequests.watch": "mutation",
  "pullRequests.unwatch": "mutation",
  "github.auth": "read",
  "github.pullRequest": "read",
  "github.pullRequestDetail": "read",
  "github.pullRequestFiles": "read",
  "github.merge": "mutation",
  "github.close": "mutation",
  "github.comment": "mutation",
  "pullRequestGuides.get": "read",
  "pullRequestGuides.retry": "mutation",
  "github.repository": "read",
  "linear.issues": "read",
  "links.favicon": "read",
  "mcp.connection": "read",
  "ports.list": "read",
  "ports.kill": "mutation",
  "terminal.open": "mutation",
  "terminal.write": "mutation",
  "terminal.resize": "mutation",
  "terminal.close": "mutation",
  "terminal.list": "read",
  "terminal.attach": "read",
  "vm.get": "read",
  "vm.start": "mutation",
  "vm.stop": "mutation",
  "vm.control": "mutation",
  "vm.host": "read",
  "vm.screen.open": "mutation",
  "vm.screen.send": "mutation",
  "vm.screen.close": "mutation",
  "vm.files.drop": "mutation",
  "vm.profile.save": "mutation",
  "vm.screenshot.save": "mutation",
  "vm.passkey.get": "read",
  "vm.passkey.prepare": "mutation",
  "vm.passkey.cancel": "mutation",
  "threads.steer": "mutation",
  "attachments.stage": "mutation",
  "attachments.read": "read",
  "dialog.pickFiles": "mutation",
  "automations.list": "read",
  "automations.create": "mutation",
  "automations.update": "mutation",
  "automations.delete": "mutation",
  "automations.runNow": "mutation",
  "automations.runs": "read",
  "network.addresses": "read",
  "system.resources": "read",
  "remote.status": "read",
  "remote.pairing": "read",
  "remote.rotateToken": "mutation",
  "remote.setupRelay": "mutation",
  "remote.removeRelay": "mutation",
  "automations.webhookUrl": "read",
}

export const mutations: ReadonlySet<string> = new Set(
  Object.entries(methodKind)
    .filter(([, kind]) => kind === "mutation")
    .map(([method]) => method),
)

/**
 * Methods that need the desktop window (dialogs, focus) or the desktop renderer (file watching), or that steer the
 * desktop itself (its settings and its paired clouds). Refused over remote.
 */
export const desktopOnlyMethods: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "app.ready",
  "app.focus",
  "app.setBadgeCount",
  "app.setColorScheme",
  "dialog.pickFolder",
  "dialog.pickFiles",
  "shell.reveal",
  "shell.openers",
  "shell.openWith",
  "notifications.permission",
  "notifications.askPermission",
  "fs.watch",
  "vm.screen.open",
  "vm.files.drop",
  "vm.passkey.prepare",
  "remote.pairing",
  "remote.rotateToken",
  "remote.setupRelay",
  "remote.removeRelay",
  "clientSettings.get",
  "clientSettings.set",
  "environments.list",
  "environments.add",
  "environments.remove",
  "environments.reconnect",
  "relayAccount.status",
  "relayAccount.signIn",
  "relayAccount.signOut",
  "relayAccount.sync",
  "relayAccount.machines",
  "relayAccount.setShown",
  "relayAccount.removeMachine",
  "relayAccount.pendingLink",
  "relayAccount.approveLink",
  "agents.update",
])
/** Pushes that only answer desktop-only methods. The remote listener does not forward them. */
export const desktopOnlyPushes: ReadonlySet<PushEvent["type"]> = new Set<PushEvent["type"]>([
  "vm.screen.data",
  "vm.screen.closed",
  "fs.changed",
  "environments.changed",
])
export type RpcRequest<M extends RpcMethod> = (typeof RpcMethods)[M]["request"]["Type"]
export type RpcResponse<M extends RpcMethod> = (typeof RpcMethods)[M]["response"]["Type"]
export type RpcRequestEncoded<M extends RpcMethod> = (typeof RpcMethods)[M]["request"]["Encoded"]
export type RpcResponseEncoded<M extends RpcMethod> = (typeof RpcMethods)[M]["response"]["Encoded"]

/** What crosses the wire when a handler fails. `tag` is the error's `_tag`. */
export interface RpcFailure {
  readonly tag: string
  readonly message: string
}

export type RpcEnvelope<A> = { readonly result: A } | { readonly error: RpcFailure }

/**
 * Pushes that change a thread's transcript. `seq` increases with every one of them, across threads,
 * so a renderer can tell which ones a `threads.transcript` snapshot already contains.
 */
export const TranscriptPush = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread.event"),
    seq: Schema.Number,
    threadId: Schema.String,
    event: AgentEvent,
  }),
  Schema.Struct({ type: Schema.Literal("message.created"), seq: Schema.Number, message: Message }),
  /** A message replaced outside the event fold, e.g. an assistant message closed by a steer. */
  Schema.Struct({ type: Schema.Literal("message.updated"), seq: Schema.Number, message: Message }),
])
export type TranscriptPush = typeof TranscriptPush.Type

/** Main -> renderer pushes on the `event` channel. */
export const PushEvent = Schema.Union([
  ...TranscriptPush.members,
  Schema.Struct({ type: Schema.Literal("thread.updated"), thread: Thread }),
  /** The thread was deleted, from this window, a phone or an automation. */
  Schema.Struct({ type: Schema.Literal("thread.removed"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("worktree.updated"), worktree: Worktree }),
  Schema.Struct({ type: Schema.Literal("worktree.setupLog"), id: Schema.String, chunk: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("thread.pullRequests"),
    threadId: Schema.String,
    links: Schema.Array(PullRequestLink),
  }),
  Schema.Struct({ type: Schema.Literal("pullRequest.guide"), url: Schema.String, state: PullRequestGuideState }),
  /** The GitHub budget dropped below a fifth (`low`) or ran out (`exhausted`). Sent once per level per window. */
  Schema.Struct({
    type: Schema.Literal("github.rateLimit"),
    level: Schema.Literals(["low", "exhausted"]),
    rateLimit: GitHubRateLimit,
  }),
  /** Every sub-agent of the thread, newest first, sent whenever one of them changes. */
  Schema.Struct({
    type: Schema.Literal("thread.subagents"),
    threadId: Schema.String,
    subagents: Schema.Array(Subagent),
  }),
  /** Every background task the thread's agent has running, oldest first, sent whenever the set changes. */
  Schema.Struct({
    type: Schema.Literal("thread.backgroundTasks"),
    threadId: Schema.String,
    tasks: Schema.Array(BackgroundTask),
  }),
  /** Something changed directly inside a folder `fs.watch` asked for. */
  Schema.Struct({ type: Schema.Literal("fs.changed"), root: Schema.String, path: Schema.String }),
  /** An automation run was recorded or changed status. */
  Schema.Struct({ type: Schema.Literal("automation.run"), run: AutomationRun }),
  /**
   * Shell output, batched to about one push per frame. `offset` is where `data` starts in the session's output, and
   * is missing from clouds older than `terminal.attach`.
   */
  Schema.Struct({
    type: Schema.Literal("terminal.data"),
    id: Schema.String,
    offset: Schema.optionalKey(TerminalOffset),
    data: Schema.String,
  }),
  /** Sent after the session's last `terminal.data`. */
  Schema.Struct({ type: Schema.Literal("terminal.exited"), id: Schema.String, exitCode: Schema.NullOr(Schema.Number) }),
  /** The updater changed state; ask updates.status for it. */
  Schema.Struct({ type: Schema.Literal("update.changed") }),
  /** The desktop's link to a cloud changed state. */
  Schema.Struct({ type: Schema.Literal("environment.status"), id: Schema.String, status: EnvironmentStatus }),
  /** A relay sync added, renamed or dropped clouds; ask environments.list again. */
  Schema.Struct({ type: Schema.Literal("environments.changed") }),
  Schema.Struct({ type: Schema.Literal("vm.updated"), threadId: Schema.String, vm: ThreadVm }),
  Schema.Struct({ type: Schema.Literal("device.updated"), threadId: Schema.String, devices: ThreadDevices }),
  Schema.Struct({ type: Schema.Literal("vm.passkey.updated"), threadId: Schema.String, passkey: VmPasskey }),
  /** VNC server bytes for an open screen stream, batched to about one push per frame. */
  Schema.Struct({ type: Schema.Literal("vm.screen.data"), streamId: Schema.String, data: Schema.Uint8Array }),
  /** Sent after the stream's last `vm.screen.data`. */
  Schema.Struct({ type: Schema.Literal("vm.screen.closed"), streamId: Schema.String }),
])
export type PushEvent = typeof PushEvent.Type

/** The bridge preload exposes as `window.hinacode`. */
export interface HinacodeBridge {
  /**
   * `environment` is a cloud's id for the few methods that name where they run (settings, accounts, models, new
   * projects). Every other method finds its environment from the ids in its payload.
   */
  readonly rpc: <M extends RpcMethod>(
    method: M,
    payload: RpcRequestEncoded<M>,
    environment?: string,
  ) => Promise<RpcEnvelope<RpcResponseEncoded<M>>>
  /** Returns an unsubscribe function. */
  readonly onEvent: (listener: (event: typeof PushEvent.Encoded) => void) => () => void
  /** Absolute path of a dropped or picked `File`; sandboxed renderers have no `File.path`. */
  readonly pathForFile: (file: File) => string
  /** Whether macOS glass sits behind the page, so the window chrome can let it through. */
  readonly liquidGlass: boolean
}
