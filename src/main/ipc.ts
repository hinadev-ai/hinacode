import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron"
import { Cause, Effect, Layer, type ManagedRuntime, Schema } from "effect"
import type { ProviderId } from "../shared/agent.ts"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import {
  PushEvent,
  type RpcEnvelope,
  type RpcMethod,
  RpcMethods,
  type RpcRequest,
  type RpcResponse,
} from "../shared/contract.ts"
import { externalUrl, isTrustedSender } from "./security.ts"
import { AgentAccounts } from "./services/AgentAccounts.ts"
import { AgentLogins } from "./services/AgentLogins.ts"
import { AgentRunner } from "./services/AgentRunner.ts"
import { Attachments } from "./services/Attachments.ts"
import { UnknownRootError } from "./services/errors.ts"
import { Events } from "./services/Events.ts"
import { Files } from "./services/Files.ts"
import { Git } from "./services/Git.ts"
import { Favicons } from "./services/Favicons.ts"
import { GitHub } from "./services/GitHub.ts"
import { Automations } from "./services/automations/Automations.ts"
import { McpCredentials } from "./mcp/index.ts"
import { Ports } from "./services/Ports.ts"
import { Projects } from "./services/Projects.ts"
import { PullRequests } from "./services/PullRequests.ts"
import { Search } from "./services/Search.ts"
import { askNotificationPermission, notificationPermission } from "./notificationPermission.ts"
import { Secrets } from "./services/Secrets.ts"
import { Settings } from "./services/Settings.ts"
import { Terminals } from "./services/Terminals.ts"
import { randomName, Threads } from "./services/Threads.ts"
import { Worktrees } from "./services/Worktrees.ts"

type AppServices =
  | AgentAccounts
  | AgentLogins
  | Projects
  | Threads
  | Worktrees
  | Settings
  | AgentRunner
  | McpCredentials
  | PullRequests
  | Search
  | Secrets
  | Ports
  | Terminals
  | Attachments
  | Automations
  | Git
  | GitHub
  | Files
  | Favicons

interface HandlerError {
  readonly _tag: string
  readonly message: string
}

type Handlers = {
  readonly [M in RpcMethod]: (
    payload: RpcRequest<M>,
    sender: WebContents,
  ) => Effect.Effect<RpcResponse<M>, HandlerError, AppServices>
}

/** The model a new thread starts with: the user's default for the agent, else the first one it lists. */
const defaultModel = (provider: ProviderId) =>
  Effect.gen(function* () {
    const { defaultModel: preferredModels } = yield* Settings.use((settings) => settings.get)
    const preferred = preferredModels[provider]
    if (preferred !== null) return preferred
    const models = yield* AgentRunner.use((runner) => runner.listModels(provider))
    return models[0]?.id ?? ""
  })

/** Git history is only read from a checkout kkcode recorded, never from a path the renderer made up. */
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

const handlers: Handlers = {
  "app.ready": (_, sender) => Effect.sync(() => BrowserWindow.fromWebContents(sender)?.show()),
  "app.focus": (_, sender) =>
    Effect.sync(() => {
      const window = BrowserWindow.fromWebContents(sender)
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }),
  "projects.list": () => Projects.use((projects) => projects.list),
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
  "threads.create": ({ projectId }) =>
    Effect.gen(function* () {
      const model = yield* defaultModel("claude")
      return yield* Threads.use((threads) =>
        threads.create({ projectId, title: randomName(), provider: "claude", model }),
      )
    }),
  // Another agent starts from its own defaults, not the model, effort and tier picked for the last one.
  "threads.update": (input) =>
    Effect.gen(function* () {
      const patch =
        input.provider === undefined
          ? input
          : {
              ...input,
              model: input.model ?? (yield* defaultModel(input.provider)),
              effort: input.effort ?? null,
              fastMode: input.fastMode ?? false,
            }
      const thread = yield* Threads.use((threads) => threads.update(patch))
      if (input.accessMode !== undefined) {
        yield* AgentRunner.use((runner) => runner.setAccessMode(thread.id, thread.accessMode))
      }
      return thread
    }),
  "threads.delete": ({ id, removeWorktree }) =>
    closeTerminals(id).pipe(Effect.andThen(Threads.use((threads) => threads.remove(id, { removeWorktree })))),

  "threads.resumeAtReset": ({ id, enabled }) => AgentRunner.use((runner) => runner.resumeAtReset(id, enabled)),

  "worktrees.list": () => Worktrees.use((worktrees) => worktrees.list),
  "worktrees.create": (input) => Worktrees.use((worktrees) => worktrees.create(input)),
  "worktrees.remove": ({ id, deleteBranch }) => Worktrees.use((worktrees) => worktrees.remove(id, deleteBranch)),
  "worktrees.setupLog": ({ id }) => Worktrees.use((worktrees) => Effect.map(worktrees.get(id), (w) => w.setupLog)),
  "worktrees.pullRequest": ({ id }) => Worktrees.use((worktrees) => worktrees.pullRequest(id)),
  "threads.changes": ({ threadId, scope }) => Threads.use((threads) => threads.changes(threadId, scope)),
  "threads.archive": ({ threadId }) => Threads.use((threads) => threads.archive(threadId)),
  "threads.unarchive": ({ threadId }) => Threads.use((threads) => threads.unarchive(threadId)),
  "projects.currentBranch": ({ id }) => Worktrees.use((worktrees) => worktrees.currentBranch(id)),
  "projects.defaultBranch": ({ id }) => Worktrees.use((worktrees) => worktrees.defaultBranch(id)),
  "projects.branches": ({ id }) => Worktrees.use((worktrees) => worktrees.branches(id)),
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
  "projects.icon": ({ id }) => Projects.use((projects) => projects.icon(id)),
  "git.log": ({ root, limit = 200 }) => knownRoot(root).pipe(Effect.andThen(Git.use((git) => git.log(root, limit)))),
  "git.show": ({ root, hash }) => knownRoot(root).pipe(Effect.andThen(Git.use((git) => git.show(root, hash)))),
  "shell.reveal": ({ path }) => Effect.sync(() => shell.showItemInFolder(path)),

  "settings.get": () => Settings.use((settings) => settings.get),
  "settings.set": (patch) => Settings.use((settings) => settings.set(patch)),
  "notifications.permission": () => notificationPermission,
  "notifications.askPermission": ({ title, body }) => askNotificationPermission(title, body),

  "models.list": ({ provider }) => AgentRunner.use((runner) => runner.listModels(provider)),
  "agents.account": ({ provider, accountId }) => AgentLogins.use((logins) => logins.account(provider, accountId)),
  "limits.list": () => AgentRunner.use((runner) => runner.limits),
  "accounts.list": () => AgentAccounts.use((accounts) => accounts.list),
  "accounts.create": (input) => AgentAccounts.use((accounts) => accounts.create(input)),
  "accounts.rename": ({ id, name }) => AgentAccounts.use((accounts) => accounts.rename(id, name)),
  "accounts.delete": ({ id }) => AgentLogins.use((logins) => logins.remove(id)),
  "accounts.signIn": ({ id }) =>
    Effect.gen(function* () {
      const { url, openedBrowser, submitCode } = yield* AgentLogins.use((logins) => logins.signIn(id))
      const external = externalUrl(url)
      if (!openedBrowser && external) yield* Effect.promise(() => shell.openExternal(external))
      return { url, acceptsCode: submitCode !== null }
    }),
  "accounts.submitCode": ({ id, code }) => AgentLogins.use((logins) => logins.submitCode(id, code)),
  "accounts.cancelSignIn": ({ id }) => AgentLogins.use((logins) => logins.cancelSignIn(id)),
  "accounts.signOut": ({ id }) => AgentLogins.use((logins) => logins.signOut(id)),
  "commands.list": ({ threadId }) => AgentRunner.use((runner) => runner.listCommands(threadId)),
  "files.list": ({ threadId }) => Threads.use((threads) => threads.listFiles(threadId)),
  "search.threads": ({ query, limit }) => Search.use((search) => search.threads(query, limit)),
  "search.files": ({ threadId, query, limit }) => Search.use((search) => search.files(threadId, query, limit)),
  "fs.list": ({ root, path }) => Files.use((files) => files.list(root, path)),
  "fs.read": ({ root, path }) => Files.use((files) => files.read(root, path)),
  "fs.watch": ({ root, paths }) => Files.use((files) => files.watch(root, paths)),
  "dialog.pickFolder": (_, sender) =>
    Effect.promise(async () => {
      const window = BrowserWindow.fromWebContents(sender)
      const options = { properties: ["openDirectory", "createDirectory"] } satisfies Electron.OpenDialogOptions
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }),

  "threads.transcript": ({ threadId }) => AgentRunner.use((runner) => runner.transcript(threadId)),
  "threads.send": ({ threadId, prompt, attachments = [], worktree }) =>
    AgentRunner.use((runner) => runner.send(threadId, prompt, attachments, { worktree })),
  "threads.steer": ({ threadId, text, attachments = [] }) =>
    AgentRunner.use((runner) => runner.steer(threadId, text, attachments)),
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
  "threads.usage": ({ threadId }) => AgentRunner.use((runner) => runner.usage(threadId)),
  "pullRequests.list": ({ threadId }) => PullRequests.use((pullRequests) => pullRequests.list(threadId)),
  "pullRequests.all": () => PullRequests.use((pullRequests) => pullRequests.listAll),
  "pullRequests.unlink": ({ threadId, url }) => PullRequests.use((pullRequests) => pullRequests.unlink(threadId, url)),
  "pullRequests.create": ({ threadId }) => PullRequests.use((pullRequests) => pullRequests.create(threadId)),
  "github.auth": () => GitHub.use((github) => github.auth),
  "github.pullRequest": ({ url }) => GitHub.use((github) => github.pullRequest(url)),
  "github.pullRequestDetail": ({ url }) => GitHub.use((github) => github.pullRequestDetail(url)),
  "github.merge": ({ url, method }) => GitHub.use((github) => github.merge(url, method)),
  "github.close": ({ url }) => GitHub.use((github) => github.close(url)),
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

  "attachments.stage": ({ threadId, source }) => Attachments.use((attachments) => attachments.stage(threadId, source)),
  "dialog.pickFiles": (_, sender) =>
    Effect.promise(async () => {
      const window = BrowserWindow.fromWebContents(sender)
      const options = { properties: ["openFile", "multiSelections"] } satisfies Electron.OpenDialogOptions
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    }),

  "automations.list": () => Automations.use((automations) => automations.list),
  "automations.create": (input) => Automations.use((automations) => automations.create(input)),
  "automations.update": (input) => Automations.use((automations) => automations.update(input)),
  "automations.delete": ({ id }) => Automations.use((automations) => automations.remove(id)),
  "automations.runNow": ({ id, payload }) => Automations.use((automations) => automations.runNow(id, payload)),
  "automations.runs": ({ id, limit }) => Automations.use((automations) => automations.runs(id, limit)),
  "automations.webhookUrl": ({ id }) => Automations.use((automations) => automations.webhookUrl(id)),
}

const RpcCall = Schema.Struct({
  method: Schema.Literals(Object.keys(RpcMethods) as [RpcMethod, ...Array<RpcMethod>]),
  payload: Schema.Unknown,
})

const call = <M extends RpcMethod>(method: M, payload: unknown, sender: WebContents) => {
  const spec = RpcMethods[method]
  const handler: Handlers[M] = handlers[method]
  return Schema.decodeUnknownEffect(spec.request)(payload).pipe(
    Effect.flatMap((request) => handler(request, sender)),
    Effect.flatMap(Schema.encodeEffect(spec.response)),
  )
}

const dispatch = (raw: unknown, sender: WebContents): Effect.Effect<RpcEnvelope<unknown>, never, AppServices> =>
  Schema.decodeUnknownEffect(RpcCall)(raw).pipe(
    Effect.flatMap(({ method, payload }) => call(method, payload, sender)),
    Effect.map((result) => ({ result })),
    Effect.catch((error: HandlerError) => Effect.succeed({ error: { tag: error._tag, message: error.message } })),
    Effect.catchCause((cause) =>
      Effect.logError("rpc defect", cause).pipe(
        Effect.as({ error: { tag: "Defect", message: Cause.pretty(cause).split("\n")[0] ?? "Unexpected error" } }),
      ),
    ),
  )

const untrustedSender: RpcEnvelope<never> = {
  error: { tag: "UntrustedSender", message: "RPC is only available to the kkcode window" },
}

/** `appUrl` is the renderer document; RPC from any other document or from a subframe is refused. */
export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown>, appUrl: string) => {
  ipcMain.handle(RPC_CHANNEL, (event, raw: unknown) =>
    isTrustedSender(event.senderFrame, appUrl)
      ? runtime.runPromise(dispatch(raw, event.sender))
      : Promise.resolve(untrustedSender),
  )
}

const encodePushEvent = Schema.encodeSync(PushEvent)

export const eventsLayer = Layer.succeed(
  Events,
  Events.of({
    publish: (event) =>
      Effect.sync(() => {
        const encoded = encodePushEvent(event)
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EVENT_CHANNEL, encoded)
      }),
  }),
)
