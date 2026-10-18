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
  AgentBinary,
  ApprovalDecision,
  ApprovalRequest,
  ModelInfo,
  ProviderId,
  Subagent,
  QuestionAnswers,
  QuestionRequest,
  SecretRequest,
  ThreadUsage,
} from "./agent.ts"
import {
  AccessMode,
  ClientSettings,
  Environment,
  Environments,
  EnvironmentStatus,
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
  MergeMethod,
  NotificationPermission,
  PermissionRequestOutcome,
  Message,
  OpenPort,
  Project,
  GitHubAuth,
  PullRequest,
  PullRequestDetail,
  PullRequestLink,
  RemotePairing,
  RemoteStatus,
  Settings,
  TerminalAttachment,
  TerminalOffset,
  TerminalSession,
  Thread,
  ThreadSearchHit,
  UpdateStatus,
  ThreadStatus,
  ThreadVm,
  VmControl,
  VmHostStatus,
  Worktree,
  WorkspaceChoice,
  OpenPullRequest,
} from "./domain.ts"
import { GitHubRepository } from "./github.ts"

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
  "app.ready": rpc(Schema.Void, Schema.Void),
  "app.focus": rpc(Schema.Void, Schema.Void),
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
      /** Only before the thread has a provider session. Null is the CLI's own login. */
      accountId: Schema.optional(Schema.NullOr(Schema.String)),
      status: Schema.optional(ThreadStatus),
      sortIndex: Schema.optional(Schema.Number),
      pinned: Schema.optional(Schema.Boolean),
    }),
    Thread,
  ),
  "threads.delete": rpc(
    Schema.Struct({ id: Schema.String, removeWorktree: Schema.optional(Schema.Boolean) }),
    Schema.Void,
  ),
  "threads.resumeAtReset": rpc(Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }), Thread),

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
  "worktrees.setupLog": rpc(Schema.Struct({ id: Schema.String }), Schema.String),
  /** The branch's GitHub pull request via `gh`, or null when there is none. */
  "worktrees.pullRequest": rpc(Schema.Struct({ id: Schema.String }), Schema.NullOr(PullRequest)),
  /** Null when the scope has no base: the thread has no live worktree, or no turn started in a git checkout. */
  "threads.changes": rpc(Schema.Struct({ threadId: Schema.String, scope: ChangesScope }), Schema.NullOr(Changes)),
  /** Archives the thread, removing its worktree when `Settings.archive.removeWorktree` is on. */
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
  /**
   * Connects once with the pairing URL's token before saving, so a typo or a rotated token fails here. Pairing a
   * cloud that is already listed updates its address and token instead of adding it again.
   */
  "environments.add": rpc(Schema.Struct({ name: Schema.String, pairingUrl: Schema.String }), Environment),
  /** Forgets the cloud and its token. Its projects and threads stay on the cloud. */
  "environments.remove": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),

  "models.list": rpc(Schema.Struct({ provider: ProviderId }), Schema.Array(ModelInfo)),
  /** Who the account is signed in as. `accountId` null is the CLI's own login. */
  "agents.account": rpc(Schema.Struct({ provider: ProviderId, accountId: Schema.NullOr(Schema.String) }), AgentAccount),
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
   * reflects every transcript push up to and including `seq`, and none after. `compact` leaves out tool outputs
   * and file diffs, for clients that never show them.
   */
  "threads.transcript": rpc(
    Schema.Struct({ threadId: Schema.String, compact: Schema.optional(Schema.Boolean) }),
    Schema.Struct({
      messages: Schema.Array(Message),
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
  /** Tokens the thread spent, read from its agent's transcripts. Null before the first turn or once they are gone. */
  "threads.usage": rpc(Schema.Struct({ threadId: Schema.String }), Schema.NullOr(ThreadUsage)),
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
  "github.merge": rpc(Schema.Struct({ url: Schema.String, method: MergeMethod }), Schema.Void),
  "github.close": rpc(Schema.Struct({ url: Schema.String }), Schema.Void),
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
  /** `listenError` is set when the webhook listener could not bind, e.g. the port is taken. */
  "remote.status": rpc(Schema.Void, RemoteStatus),
  "remote.pairing": rpc(Schema.Void, RemotePairing),
  /** Replaces the access token and disconnects every phone. */
  "remote.rotateToken": rpc(Schema.Void, RemotePairing),
  "automations.webhookUrl": rpc(
    Schema.Struct({ id: Schema.String }),
    Schema.Struct({ url: Schema.String, listenError: Schema.NullOr(Schema.String) }),
  ),
}

export type RpcMethod = keyof typeof RpcMethods

/** Reads rerun after a reconnect; mutations retain one call key for the whole action. */
export const methodKind: Record<RpcMethod, "read" | "mutation"> = {
  "app.ready": "mutation",
  "app.focus": "mutation",
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
  "worktrees.list": "read",
  "worktrees.create": "mutation",
  "worktrees.remove": "mutation",
  "worktrees.setupLog": "read",
  "worktrees.pullRequest": "read",
  "threads.changes": "read",
  "threads.archive": "mutation",
  "threads.unarchive": "mutation",
  "projects.currentBranch": "read",
  "projects.defaultBranch": "read",
  "projects.branches": "read",
  "projects.pullRequests": "read",
  "projects.fetch": "mutation",
  "projects.icon": "read",
  "git.log": "read",
  "git.show": "read",
  "shell.reveal": "mutation",
  "settings.get": "read",
  "notifications.permission": "read",
  "notifications.askPermission": "mutation",
  "settings.set": "mutation",
  "clientSettings.get": "read",
  "clientSettings.set": "mutation",
  "environments.list": "read",
  "environments.add": "mutation",
  "environments.remove": "mutation",
  "models.list": "read",
  "agents.account": "read",
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
  "threads.usage": "read",
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
  "github.merge": "mutation",
  "github.close": "mutation",
  "github.repository": "read",
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
  "remote.status": "read",
  "remote.pairing": "read",
  "remote.rotateToken": "mutation",
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
  "dialog.pickFolder",
  "dialog.pickFiles",
  "shell.reveal",
  "notifications.permission",
  "notifications.askPermission",
  "fs.watch",
  "vm.screen.open",
  "vm.files.drop",
  "remote.pairing",
  "remote.rotateToken",
  "clientSettings.get",
  "clientSettings.set",
  "environments.list",
  "environments.add",
  "environments.remove",
])
/** Pushes that only answer desktop-only methods. The remote listener does not forward them. */
export const desktopOnlyPushes: ReadonlySet<PushEvent["type"]> = new Set<PushEvent["type"]>([
  "vm.screen.data",
  "vm.screen.closed",
  "fs.changed",
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
  /** Every sub-agent of the thread, newest first, sent whenever one of them changes. */
  Schema.Struct({
    type: Schema.Literal("thread.subagents"),
    threadId: Schema.String,
    subagents: Schema.Array(Subagent),
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
  Schema.Struct({ type: Schema.Literal("vm.updated"), threadId: Schema.String, vm: ThreadVm }),
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
}
