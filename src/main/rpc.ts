import { homedir } from "node:os"
import { Cause, Effect, Schema } from "effect"
import type { ProviderId } from "../shared/agent.ts"
import { availableUpdates, installUpdate } from "./agents/updates.ts"
import { compactMessage, transcriptPage } from "../shared/compactTranscript.ts"
import type {
  NotificationPermission,
  Opener,
  OpenerId,
  PermissionRequestOutcome,
  PullRequestDetail,
  Thread,
  WorkspaceChoice,
} from "../shared/domain.ts"
import { type RpcEnvelope, type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../shared/contract.ts"
import { AgentAccounts } from "./services/AgentAccounts.ts"
import { AgentLogins } from "./services/AgentLogins.ts"
import { AgentRunner } from "./services/AgentRunner.ts"
import { Attachments } from "./services/Attachments.ts"
import { Browser } from "./services/Browser.ts"
import { UnknownRootError } from "./services/errors.ts"
import { ClientSettings } from "./services/ClientSettings.ts"
import { Environments } from "./services/Environments.ts"
import { Events } from "./services/Events.ts"
import { Files } from "./services/Files.ts"
import { Git } from "./services/Git.ts"
import { Favicons } from "./services/Favicons.ts"
import { GitHub, pullRequestFiles } from "./services/GitHub.ts"
import { Automations } from "./services/automations/Automations.ts"
import { Linear } from "./services/Linear.ts"
import { McpCredentials } from "./mcp/index.ts"
import { Ports } from "./services/Ports.ts"
import { networkAddresses, RemoteAccess } from "./remote/access.ts"
import { Relay } from "./remote/relay.ts"
import { Projects } from "./services/Projects.ts"
import { PullRequestGuides } from "./services/PullRequestGuides.ts"
import { PullRequests } from "./services/PullRequests.ts"
import { RelayAccount } from "./services/RelayAccount.ts"
import { Search } from "./services/Search.ts"
import { Secrets } from "./services/Secrets.ts"
import { Settings } from "./services/Settings.ts"
import { SystemResources } from "./services/SystemResources.ts"
import { Terminals } from "./services/Terminals.ts"
import { Updates } from "./services/Updates.ts"
import { randomName, Threads } from "./services/Threads.ts"
import { VmPasskeyRelay } from "./services/tinyVm/passkey/PasskeyRelay.ts"
import { type ScreenOwner, TinyVm, VmError } from "./services/tinyVm/TinyVm.ts"
import { Worktrees } from "./services/Worktrees.ts"

export type AppServices =
  | AgentAccounts
  | AgentLogins
  | Projects
  | Threads
  | Worktrees
  | Settings
  | SystemResources
  | ClientSettings
  | Environments
  | AgentRunner
  | McpCredentials
  | PullRequests
  | PullRequestGuides
  | Search
  | Secrets
  | Ports
  | Terminals
  | Attachments
  | Browser
  | Automations
  | Git
  | GitHub
  | Linear
  | Files
  | Favicons
  | Updates
  | RemoteAccess
  | Relay
  | RelayAccount
  | Events
  | TinyVm
  | VmPasskeyRelay

export interface HandlerError {
  readonly _tag: string
  readonly message: string
}

/**
 * What only the desktop window can do, bound to the window that called. `ipc.ts` builds it; remote callers
 * pass null, and the remote listener refuses these methods before they reach a handler.
 */
export interface DesktopCalls {
  readonly show: Effect.Effect<void>
  readonly focus: Effect.Effect<void>
  readonly setBadgeCount: (count: number) => Effect.Effect<void>;
  readonly setColorScheme: (scheme: "dark" | "light" | "system") => Effect.Effect<void>
  readonly reveal: (path: string) => Effect.Effect<void>
  readonly openers: Effect.Effect<ReadonlyArray<Opener>>
  readonly openWith: (path: string, opener: OpenerId) => Effect.Effect<void, HandlerError>
  /** Opens an http(s) URL in the default browser. Anything else is ignored. */
  readonly openExternal: (url: string) => Effect.Effect<void>
  readonly pickFolder: Effect.Effect<string | null>
  readonly pickFiles: Effect.Effect<ReadonlyArray<string>>
  readonly notificationPermission: Effect.Effect<NotificationPermission>
  readonly askNotificationPermission: (title: string, body: string) => Effect.Effect<PermissionRequestOutcome>
  readonly screenOwner: ScreenOwner | null
}

type Handlers = {
  readonly [M in RpcMethod]: (
    payload: RpcRequest<M>,
    desktop: DesktopCalls | null,
  ) => Effect.Effect<RpcResponse<M>, HandlerError, AppServices>
}

/** What a new thread of `provider` starts with: the options last picked for one, else the agent's first model. */
const newThreadOptions = (provider: ProviderId) =>
  Effect.gen(function* () {
    const settings = yield* Settings.use((service) => service.get)
    const model =
      settings.defaultModel[provider] ?? (yield* AgentRunner.use((runner) => runner.listModels(provider)))[0]?.id ?? ""
    return { model, effort: settings.defaultEffort[provider], fastMode: settings.defaultFastMode[provider] }
  })

/** A thread's options become the next new thread's defaults while it is still being set up, before its first message. */
const rememberNewThreadOptions = (thread: Thread) =>
  Effect.gen(function* () {
    if (yield* Threads.use((threads) => threads.started(thread.id))) return
    const settings = yield* Settings.use((service) => service.get)
    const provider = thread.provider
    yield* Settings.use((service) =>
      service.set({
        defaultProvider: provider,
        defaultModel: { ...settings.defaultModel, [provider]: thread.model },
        defaultEffort: { ...settings.defaultEffort, [provider]: thread.effort },
        defaultFastMode: { ...settings.defaultFastMode, [provider]: thread.fastMode },
        defaultAccessMode: thread.accessMode,
        defaultAccount: { ...settings.defaultAccount, [provider]: thread.accountId },
      }),
    )
  })

/** Where a repository thread's first turn runs becomes where the next new one starts. Returns the save to run once it sent. */
const rememberWorkspaceMode = (threadId: string, mode: WorkspaceChoice["mode"]) =>
  Effect.gen(function* () {
    const thread = yield* Threads.use((threads) => threads.get(threadId))
    const project = yield* Projects.use((projects) => projects.get(thread.projectId))
    const first = thread.worktreeId === null && !(yield* Threads.use((threads) => threads.started(threadId)))
    return first && project.kind === "folder"
      ? Settings.use((service) => service.set({ defaultWorkspaceMode: mode })).pipe(Effect.asVoid)
      : Effect.void
  })

/** Git history is only read from a checkout hinacode recorded, never from a path the renderer made up. */
const knownRoot = (root: string) =>
  Effect.gen(function* () {
    const projects = yield* Projects.use((service) => service.list)
    const worktrees = yield* Worktrees.use((service) => service.list)
    const known =
      projects.some((project) => project.rootPath === root) ||
      worktrees.some((worktree) => worktree.path === root && worktree.status !== "removed")
    if (!known) return yield* new UnknownRootError({ root })
    return root
  })

/** Shells sitting in a worktree would outlive it, so they end before the thread or its project goes away. */
const closeTerminals = (threadId: string) => Terminals.use((terminals) => terminals.closeThread(threadId))

const startGuideForHead = (detail: PullRequestDetail) => PullRequestGuides.use((guides) => guides.ensure(detail))

const handlers: Handlers = {
  "browser.open": (input) => Browser.use((browser) => browser.open(input)),
  "browser.command": (input) => Browser.use((browser) => browser.command(input)),
  "browser.frame": (input) => Browser.use((browser) => browser.frame(input)),
  "browser.close": (input) => Browser.use((browser) => browser.close(input)),
  "app.ready": (_, desktop) => desktop?.show ?? Effect.void,
  "app.focus": (_, desktop) => desktop?.focus ?? Effect.void,
  "app.setBadgeCount": ({ count }, desktop) => desktop?.setBadgeCount(count) ?? Effect.void,
  "app.setColorScheme": (scheme, desktop) => desktop?.setColorScheme(scheme) ?? Effect.void,
  "projects.list": () => Projects.use((projects) => projects.listWithRepositories),
  "projects.create": (input) => Projects.use((projects) => projects.create(input)),
  "projects.clone": (input) => Projects.use((projects) => projects.clone(input)),
  "projects.update": (input) => Projects.use((projects) => projects.update(input)),
  "projects.delete": ({ id }) =>
    Effect.gen(function* () {
      const threads = yield* Threads.use((service) => service.list)
      yield* Effect.forEach(
        threads.filter((thread) => thread.projectId === id),
        (thread) => closeTerminals(thread.id),
      )
      yield* Projects.use((projects) => projects.remove(id))
    }),

  "threads.list": () => Threads.use((threads) => threads.list),
  // Thread changes are pushed as well as returned, so a phone and the desktop window stay in step.
  "threads.create": ({ projectId }) =>
    Effect.gen(function* () {
      const { defaultProvider: provider } = yield* Settings.use((service) => service.get)
      const options = yield* newThreadOptions(provider)
      const thread = yield* Threads.use((threads) =>
        threads.create({ projectId, title: randomName(), provider, ...options }),
      )
      yield* Events.use((events) => events.publish({ type: "thread.updated", thread }))
      return thread
    }),
  // Another agent starts from its own defaults, not the model, effort and tier picked for the last one.
  "threads.update": (input) =>
    Effect.gen(function* () {
      const { provider: switchTo } = input
      const thread =
        switchTo === undefined
          ? yield* Threads.use((threads) => threads.update(input))
          : yield* newThreadOptions(switchTo).pipe(
              Effect.flatMap((defaults) =>
                AgentRunner.use((runner) => runner.switchAgent({ ...defaults, ...input, provider: switchTo })),
              ),
            )
      if (input.accessMode !== undefined) {
        yield* AgentRunner.use((runner) => runner.setAccessMode(thread.id, thread.accessMode))
      }
      const { provider, model, effort, fastMode, accessMode } = input
      if ([provider, model, effort, fastMode, accessMode].some((option) => option !== undefined)) {
        yield* rememberNewThreadOptions(thread)
      }
      yield* Events.use((events) => events.publish({ type: "thread.updated", thread }))
      return thread
    }),
  "threads.delete": ({ id, removeWorktree }) =>
    closeTerminals(id).pipe(
      Effect.andThen(Threads.use((threads) => threads.remove(id, { removeWorktree }))),
      Effect.andThen(Events.use((events) => events.publish({ type: "thread.removed", id }))),
    ),

  "threads.resumeAtReset": ({ id, enabled }) => AgentRunner.use((runner) => runner.resumeAtReset(id, enabled)),
  "threads.switchAccount": ({ id, accountId, resend }) =>
    AgentRunner.use((runner) => runner.switchAccount(id, accountId, { resend: resend ?? false })).pipe(
      Effect.tap(rememberNewThreadOptions),
    ),

  "worktrees.list": () => Worktrees.use((worktrees) => worktrees.list),
  "worktrees.create": (input) => Worktrees.use((worktrees) => worktrees.create(input)),
  "worktrees.remove": ({ id, deleteBranch }) => Worktrees.use((worktrees) => worktrees.remove(id, deleteBranch)),
  "worktrees.checkouts": () => Worktrees.use((worktrees) => worktrees.checkouts),
  "worktrees.setupLog": ({ id }) => Worktrees.use((worktrees) => Effect.map(worktrees.get(id), (w) => w.setupLog)),
  "worktrees.stopSetup": ({ id }) => Worktrees.use((worktrees) => worktrees.stopSetup(id)),
  "worktrees.pullRequest": ({ id }) => Worktrees.use((worktrees) => worktrees.pullRequest(id)),
  "threads.changes": ({ threadId, scope }) => Threads.use((threads) => threads.changes(threadId, scope)),
  "threads.archive": ({ threadId }) => Threads.use((threads) => threads.archive(threadId)),
  "threads.unarchive": ({ threadId }) => Threads.use((threads) => threads.unarchive(threadId)),
  "threads.fork": ({ threadId, messageId }) =>
    Threads.use((threads) => threads.fork(threadId, messageId)).pipe(
      Effect.tap((thread) => Events.use((events) => events.publish({ type: "thread.updated", thread }))),
    ),
  "projects.currentBranch": ({ id }) => Worktrees.use((worktrees) => worktrees.currentBranch(id)),
  "projects.defaultBranch": ({ id }) => Worktrees.use((worktrees) => worktrees.defaultBranch(id)),
  "projects.branches": ({ id }) => Worktrees.use((worktrees) => worktrees.branches(id)),
  "projects.fetch": ({ id }) => Worktrees.use((worktrees) => worktrees.fetch(id)),
  "projects.pullRequests": ({ id }) =>
    Effect.gen(function* () {
      const { rootPath } = yield* Projects.use((projects) => projects.get(id))
      return yield* GitHub.use((github) => github.openPullRequests(rootPath))
    }).pipe(
      Effect.catchTags({
        GitHubCliMissingError: () => Effect.succeed([]),
        GitHubSignedOutError: () => Effect.succeed([]),
      }),
    ),
  "projects.searchPullRequests": ({ id, query }) =>
    Effect.gen(function* () {
      const { rootPath } = yield* Projects.use((projects) => projects.get(id))
      const repository = yield* GitHub.use((github) => github.repository(rootPath))
      if (repository === null) return []
      return yield* GitHub.use((github) => github.searchPullRequests(repository, query))
    }).pipe(
      Effect.catchTags({
        GitHubCliMissingError: () => Effect.succeed([]),
        GitHubSignedOutError: () => Effect.succeed([]),
      }),
    ),
  "projects.icon": ({ id }) => Projects.use((projects) => projects.icon(id)),
  "git.log": ({ root, limit = 200 }) => knownRoot(root).pipe(Effect.andThen(Git.use((git) => git.log(root, limit)))),
  "git.show": ({ root, hash }) => knownRoot(root).pipe(Effect.andThen(Git.use((git) => git.show(root, hash)))),
  "shell.reveal": ({ path }, desktop) => desktop?.reveal(path) ?? Effect.void,
  "shell.openers": (_, desktop) => desktop?.openers ?? Effect.succeed([]),
  "shell.openWith": ({ path, opener }, desktop) => desktop?.openWith(path, opener) ?? Effect.void,

  "settings.get": () => Settings.use((settings) => settings.get),
  "settings.set": (patch) => Settings.use((settings) => settings.set(patch)),
  "clientSettings.get": () => ClientSettings.use((settings) => settings.get),
  "clientSettings.set": (patch) => ClientSettings.use((settings) => settings.set(patch)),
  "environments.list": () => Environments.use((environments) => environments.list),
  "environments.add": (input) => Environments.use((environments) => environments.add(input)),
  "environments.remove": ({ id }) => Environments.use((environments) => environments.remove(id)),
  "environments.reconnect": ({ id }) => Environments.use((environments) => environments.reconnect(id)),
  "relayAccount.status": () => RelayAccount.use((account) => account.status),
  "relayAccount.signIn": ({ ownerToken }) => RelayAccount.use((account) => account.signIn(ownerToken)),
  "relayAccount.signOut": () => RelayAccount.use((account) => account.signOut),
  "relayAccount.sync": () => RelayAccount.use((account) => account.sync),
  "relayAccount.machines": () => RelayAccount.use((account) => account.machines),
  "relayAccount.setShown": (input) => RelayAccount.use((account) => account.setShown(input)),
  "relayAccount.removeMachine": (input) => RelayAccount.use((account) => account.removeMachine(input)),
  "relayAccount.pendingLink": ({ userCode }) => RelayAccount.use((account) => account.pendingLink(userCode)),
  "relayAccount.approveLink": ({ userCode }) => RelayAccount.use((account) => account.approveLink(userCode)),
  "notifications.permission": (_, desktop) => desktop?.notificationPermission ?? Effect.succeed("unknown" as const),
  "notifications.askPermission": ({ title, body }, desktop) =>
    desktop?.askNotificationPermission(title, body) ?? Effect.succeed("noAnswer" as const),

  "models.list": ({ provider }) => AgentRunner.use((runner) => runner.listModels(provider)),
  "agents.account": ({ provider, accountId }) => AgentLogins.use((logins) => logins.account(provider, accountId)),
  // e2e runs on machines with real, possibly outdated CLIs, whose update toast would cover the UI under test.
  "agents.updates": () => (process.env["HINACODE_SKIP_AGENT_UPDATES"] ? Effect.succeed([]) : availableUpdates),
  "agents.update": ({ provider }) => installUpdate(provider),
  "limits.list": () => AgentRunner.use((runner) => runner.limits),
  "accounts.list": () => AgentAccounts.use((accounts) => accounts.list),
  "accounts.create": (input) => AgentAccounts.use((accounts) => accounts.create(input)),
  "accounts.rename": ({ id, name }) => AgentAccounts.use((accounts) => accounts.rename(id, name)),
  "accounts.delete": ({ id }) => AgentAccounts.use((accounts) => accounts.remove(id)),
  "commands.list": ({ threadId }) => AgentRunner.use((runner) => runner.listCommands(threadId)),
  "files.list": ({ threadId }) => Threads.use((threads) => threads.listFiles(threadId)),
  "search.threads": ({ query, limit }) => Search.use((search) => search.threads(query, limit)),
  "search.files": ({ threadId, query, limit }) => Search.use((search) => search.files(threadId, query, limit)),
  "fs.list": ({ root, path }) => Files.use((files) => files.list(root, path)),
  "fs.read": ({ root, path }) => Files.use((files) => files.read(root, path)),
  "fs.preview": ({ root, path }) => Files.use((files) => files.preview(root, path)),
  "fs.write": ({ root, path, content, expected }) => Files.use((files) => files.write(root, path, content, expected)),
  "fs.watch": ({ root, paths }) => Files.use((files) => files.watch(root, paths)),
  "dialog.pickFolder": (_, desktop) => desktop?.pickFolder ?? Effect.succeed(null),

  "updates.status": () => Updates.use((updates) => updates.status),
  "updates.check": () => Updates.use((updates) => updates.check),
  "updates.install": () => Updates.use((updates) => updates.install),

  "threads.transcript": ({ threadId, compact = false, page }) =>
    AgentRunner.use((runner) => runner.transcript(threadId)).pipe(
      Effect.map((transcript) => {
        const messages = compact ? transcript.messages.map(compactMessage) : transcript.messages
        return page === undefined
          ? { ...transcript, messages }
          : { ...transcript, ...transcriptPage(messages, page.before) }
      }),
    ),
  "threads.send": ({ threadId, prompt, attachments = [], workspace }) =>
    Effect.gen(function* () {
      const remember = yield* rememberWorkspaceMode(threadId, workspace?.mode ?? "local")
      yield* AgentRunner.use((runner) => runner.send(threadId, prompt, attachments, { workspace }))
      yield* remember
    }),
  "threads.steer": ({ threadId, text, attachments = [] }) =>
    AgentRunner.use((runner) => runner.steer(threadId, text, attachments)),
  "threads.queue": ({ threadId, text, attachments = [] }) =>
    AgentRunner.use((runner) => runner.queue(threadId, text, attachments)),
  "threads.unqueue": ({ threadId, id }) => AgentRunner.use((runner) => runner.unqueue(threadId, id)),
  "threads.interrupt": ({ threadId }) => AgentRunner.use((runner) => runner.interrupt(threadId)),
  "approvals.respond": ({ requestId, decision }) =>
    AgentRunner.use((runner) => runner.respondApproval(requestId, decision)),
  "questions.respond": ({ requestId, answers }) =>
    AgentRunner.use((runner) => runner.respondQuestion(requestId, answers)),
  "secrets.respond": ({ requestId, value }) => AgentRunner.use((runner) => runner.respondSecret(requestId, value)),

  "secrets.has": ({ name }) => Secrets.use((secrets) => secrets.has(name)),
  "secrets.set": ({ name, value }) => Secrets.use((secrets) => secrets.set(name, value)),
  "secrets.clear": ({ name }) => Secrets.use((secrets) => secrets.clear(name)),
  "subagents.list": ({ threadId }) => AgentRunner.use((runner) => runner.subagents(threadId)),
  "subagents.stop": ({ threadId, subagentId }) =>
    AgentRunner.use((runner) => runner.stopSubagent(threadId, subagentId)),
  "backgroundTasks.list": ({ threadId }) => AgentRunner.use((runner) => runner.backgroundTasks(threadId)),
  "backgroundTasks.stop": ({ threadId, taskId }) =>
    AgentRunner.use((runner) => runner.stopBackgroundTask(threadId, taskId)),
  "threads.usage": ({ threadId }) => AgentRunner.use((runner) => runner.usage(threadId)),
  "threads.contextBreakdown": ({ threadId }) => AgentRunner.use((runner) => runner.contextBreakdown(threadId)),
  "pullRequests.list": ({ threadId }) => PullRequests.use((pullRequests) => pullRequests.list(threadId)),
  "pullRequests.all": () => PullRequests.use((pullRequests) => pullRequests.listAll),
  "pullRequests.unlink": ({ threadId, url }) => PullRequests.use((pullRequests) => pullRequests.unlink(threadId, url)),
  "pullRequests.create": ({ threadId }) => PullRequests.use((pullRequests) => pullRequests.create(threadId)),
  "pullRequests.watch": ({ threadId, url }) => PullRequests.use((pullRequests) => pullRequests.watch(threadId, url)),
  "pullRequests.unwatch": ({ threadId, url }) =>
    PullRequests.use((pullRequests) => pullRequests.unwatch(threadId, url)),
  "github.auth": () => GitHub.use((github) => github.auth),
  "github.pullRequest": ({ url }) => GitHub.use((github) => github.pullRequest(url)),
  "github.pullRequestDetail": ({ url }) =>
    GitHub.use((github) => github.pullRequestDetail(url)).pipe(Effect.tap(startGuideForHead)),
  "github.pullRequestFiles": ({ url }) =>
    GitHub.use((github) => github.pullRequestDiff(url)).pipe(Effect.flatMap(pullRequestFiles)),
  "pullRequestGuides.get": ({ url }) => PullRequestGuides.use((guides) => guides.get(url)),
  "pullRequestGuides.retry": ({ url }) => PullRequestGuides.use((guides) => guides.retry(url)),
  "github.merge": ({ url, method }) => GitHub.use((github) => github.merge(url, method)),
  "github.close": ({ url }) => GitHub.use((github) => github.close(url)),
  "linear.issues": () => Linear.use((linear) => linear.assignedIssues),
  "github.repository": ({ projectId }) =>
    Projects.use((projects) => projects.get(projectId)).pipe(
      Effect.flatMap(({ rootPath }) => GitHub.use((github) => github.repository(rootPath))),
    ),
  "links.favicon": ({ url }) => Favicons.use((favicons) => favicons.favicon(url)),
  "mcp.connection": ({ threadId }) => McpCredentials.use((mcp) => mcp.connectionFor(threadId)),
  "ports.list": ({ threadId }) => Ports.use((ports) => ports.listForThread(threadId)),
  "ports.kill": ({ pid }) => Ports.use((ports) => ports.kill(pid)),
  "terminal.open": (input) => Terminals.use((terminals) => terminals.open(input)),
  "terminal.write": ({ id, data }) => Terminals.use((terminals) => terminals.write(id, data)),
  "terminal.resize": ({ id, cols, rows }) => Terminals.use((terminals) => terminals.resize(id, cols, rows)),
  "terminal.close": ({ id }) => Terminals.use((terminals) => terminals.close(id)),
  "terminal.list": ({ threadId }) => Terminals.use((terminals) => terminals.list(threadId)),
  "terminal.attach": ({ id, since }) => Terminals.use((terminals) => terminals.attach(id, since)),

  "vm.get": ({ threadId }) => TinyVm.use((vm) => vm.get(threadId)),
  "vm.start": ({ threadId, template }) => TinyVm.use((vm) => vm.start(threadId, template)),
  "vm.stop": ({ threadId }) => TinyVm.use((vm) => vm.stop(threadId)),
  "vm.control": ({ threadId, control }) => TinyVm.use((vm) => vm.setControl(threadId, control)),
  "vm.host": () => TinyVm.use((vm) => vm.host),
  "vm.screen.open": ({ threadId, streamId }, desktop) => {
    const owner = desktop?.screenOwner
    return owner
      ? TinyVm.use((vm) => vm.openScreen(threadId, streamId, owner))
      : new VmError({ message: "The VM screen is only available in the desktop window." })
  },
  "vm.screen.send": ({ streamId, data }) => TinyVm.use((vm) => vm.sendScreen(streamId, data)),
  "vm.screen.close": ({ streamId }) => TinyVm.use((vm) => vm.closeScreen(streamId)),
  "vm.files.drop": ({ threadId, paths }) => TinyVm.use((vm) => vm.dropFiles(threadId, paths)),
  "vm.profile.save": ({ threadId }) => TinyVm.use((vm) => vm.saveProfile(threadId)),
  "vm.screenshot.save": ({ threadId }) =>
    Effect.gen(function* () {
      const data = yield* TinyVm.use((vm) => vm.screenshot(threadId))
      return yield* Attachments.use((attachments) =>
        attachments.stage(threadId, {
          dataUrl: `data:image/png;base64,${Buffer.from(data).toString("base64")}`,
          name: "vm-screenshot.png",
        }),
      )
    }),
  "vm.passkey.get": ({ threadId }) => VmPasskeyRelay.use((relay) => relay.get(threadId)),
  "vm.passkey.prepare": ({ threadId }) => VmPasskeyRelay.use((relay) => relay.prepare(threadId)),
  "vm.passkey.cancel": ({ threadId }) => VmPasskeyRelay.use((relay) => relay.cancel(threadId)),

  "attachments.stage": ({ threadId, source }) => Attachments.use((attachments) => attachments.stage(threadId, source)),
  "attachments.read": ({ path }) => Attachments.use((attachments) => attachments.read(path)),
  "dialog.pickFiles": (_, desktop) => desktop?.pickFiles ?? Effect.succeed([]),

  "automations.list": () => Automations.use((automations) => automations.list),
  "automations.create": (input) => Automations.use((automations) => automations.create(input)),
  "automations.update": (input) => Automations.use((automations) => automations.update(input)),
  "automations.delete": ({ id }) => Automations.use((automations) => automations.remove(id)),
  "automations.runNow": ({ id, payload }) => Automations.use((automations) => automations.runNow(id, payload)),
  "automations.runs": ({ id, limit }) => Automations.use((automations) => automations.runs(id, limit)),
  "automations.webhookUrl": ({ id }) => Automations.use((automations) => automations.webhookUrl(id)),

  "network.addresses": () => Effect.sync(() => networkAddresses()),
  "system.resources": () =>
    Effect.gen(function* () {
      const projects = yield* Projects.use((service) => service.list)
      const { worktreeRoot } = yield* Settings.use((settings) => settings.get)
      const paths = [homedir(), ...projects.map((project) => project.rootPath), ...(worktreeRoot ? [worktreeRoot] : [])]
      return yield* SystemResources.use((resources) => resources.read(paths))
    }),
  "machines.list": () =>
    Effect.gen(function* () {
      const { identity } = yield* RemoteAccess
      const projects = yield* Projects.use((service) => service.list)
      return [{ ...identity, projectIds: projects.map((project) => project.id) }]
    }),
  "remote.status": () => RemoteAccess.use((remote) => remote.status),
  "remote.pairing": () => RemoteAccess.use((remote) => remote.pairing),
  "remote.rotateToken": () => RemoteAccess.use((remote) => remote.rotateToken),
  "remote.setupRelay": (_, desktop) =>
    Effect.gen(function* () {
      const account = yield* RelayAccount
      const relay = yield* Relay
      yield* relay.setup({
        onLink: (link) =>
          account
            .approveOwnLink(link.userCode)
            .pipe(
              Effect.flatMap((approved) => (approved ? Effect.void : (desktop?.openExternal(link.url) ?? Effect.void))),
            ),
      })
    }).pipe(Effect.andThen(RemoteAccess.use((remote) => remote.pairing))),
  "remote.removeRelay": () =>
    Relay.use((relay) => relay.remove).pipe(Effect.andThen(RemoteAccess.use((remote) => remote.pairing))),
}

export const RpcCall = Schema.Struct({
  method: Schema.Literals(Object.keys(RpcMethods) as [RpcMethod, ...Array<RpcMethod>]),
  payload: Schema.Unknown,
})

const call = <M extends RpcMethod>(method: M, payload: unknown, desktop: DesktopCalls | null) => {
  const spec = RpcMethods[method]
  const handler: Handlers[M] = handlers[method]
  return Schema.decodeUnknownEffect(spec.request)(payload).pipe(
    Effect.flatMap((request) => handler(request, desktop)),
    Effect.flatMap(Schema.encodeEffect(spec.response)),
  )
}

/**
 * Decodes one `{ method, payload }` call, runs its handler and encodes the answer. Shared by the Electron
 * `rpc` channel and the remote listener, which passes null for `desktop`.
 */
export const dispatch = (
  raw: unknown,
  desktop: DesktopCalls | null,
): Effect.Effect<RpcEnvelope<unknown>, never, AppServices> =>
  Schema.decodeUnknownEffect(RpcCall)(raw).pipe(
    Effect.flatMap(({ method, payload }) => call(method, payload, desktop)),
    Effect.map((result) => ({ result })),
    Effect.catch((error: HandlerError) => Effect.succeed({ error: { tag: error._tag, message: error.message } })),
    Effect.catchCause((cause) =>
      Effect.logError("rpc defect", cause).pipe(
        Effect.as({ error: { tag: "Defect", message: Cause.pretty(cause).split("\n")[0] ?? "Unexpected error" } }),
      ),
    ),
  )
