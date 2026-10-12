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
import { isTrustedSender } from "./security.ts"
import { AgentRunner } from "./services/AgentRunner.ts"
import { Attachments } from "./services/Attachments.ts"
import { Events } from "./services/Events.ts"
import { GitHub } from "./services/GitHub.ts"
import { Automations } from "./services/automations/Automations.ts"
import { McpCredentials } from "./mcp/index.ts"
import { Ports } from "./services/Ports.ts"
import { Projects } from "./services/Projects.ts"
import { PullRequests } from "./services/PullRequests.ts"
import { Secrets } from "./services/Secrets.ts"
import { Settings } from "./services/Settings.ts"
import { randomName, Threads } from "./services/Threads.ts"
import { Worktrees } from "./services/Worktrees.ts"

type AppServices =
  | Projects
  | Threads
  | Worktrees
  | Settings
  | AgentRunner
  | McpCredentials
  | PullRequests
  | Secrets
  | Ports
  | Attachments
  | Automations
  | GitHub

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

const handlers: Handlers = {
  "app.ready": (_, sender) => Effect.sync(() => BrowserWindow.fromWebContents(sender)?.show()),
  "projects.list": () => Projects.use((projects) => projects.list),
  "projects.create": (input) => Projects.use((projects) => projects.create(input)),
  "projects.clone": (input) => Projects.use((projects) => projects.clone(input)),
  "projects.update": (input) => Projects.use((projects) => projects.update(input)),
  "projects.delete": ({ id }) => Projects.use((projects) => projects.remove(id)),

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
      if (input.provider === undefined) return yield* Threads.use((threads) => threads.update(input))
      const model = input.model ?? (yield* defaultModel(input.provider))
      return yield* Threads.use((threads) =>
        threads.update({ ...input, model, effort: input.effort ?? null, fastMode: input.fastMode ?? false }),
      )
    }),
  "threads.delete": ({ id, removeWorktree }) => Threads.use((threads) => threads.remove(id, { removeWorktree })),

  "worktrees.list": () => Worktrees.use((worktrees) => worktrees.list),
  "worktrees.create": (input) => Worktrees.use((worktrees) => worktrees.create(input)),
  "worktrees.remove": ({ id, deleteBranch }) => Worktrees.use((worktrees) => worktrees.remove(id, deleteBranch)),
  "worktrees.changes": ({ id }) => Worktrees.use((worktrees) => worktrees.changes(id)),
  "worktrees.setupLog": ({ id }) => Worktrees.use((worktrees) => Effect.map(worktrees.get(id), (w) => w.setupLog)),
  "worktrees.pullRequest": ({ id }) => Worktrees.use((worktrees) => worktrees.pullRequest(id)),
  "threads.settle": ({ threadId }) => Threads.use((threads) => threads.settle(threadId)),
  "projects.currentBranch": ({ id }) => Worktrees.use((worktrees) => worktrees.currentBranch(id)),
  "shell.reveal": ({ path }) => Effect.sync(() => shell.showItemInFolder(path)),

  "settings.get": () => Settings.use((settings) => settings.get),
  "settings.set": (patch) => Settings.use((settings) => settings.set(patch)),

  "models.list": ({ provider }) => AgentRunner.use((runner) => runner.listModels(provider)),
  "commands.list": ({ threadId }) => AgentRunner.use((runner) => runner.listCommands(threadId)),
  "files.list": ({ threadId }) => Threads.use((threads) => threads.listFiles(threadId)),

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
  "secrets.respond": ({ requestId, value }) => AgentRunner.use((runner) => runner.respondSecret(requestId, value)),

  "secrets.has": ({ name }) => Secrets.use((secrets) => secrets.has(name)),
  "secrets.set": ({ name, value }) => Secrets.use((secrets) => secrets.set(name, value)),
  "secrets.clear": ({ name }) => Secrets.use((secrets) => secrets.clear(name)),
  "subagents.list": ({ threadId }) => AgentRunner.use((runner) => runner.subagents(threadId)),
  "pullRequests.list": ({ threadId }) => PullRequests.use((pullRequests) => pullRequests.list(threadId)),
  "pullRequests.all": () => PullRequests.use((pullRequests) => pullRequests.listAll),
  "pullRequests.unlink": ({ threadId, url }) => PullRequests.use((pullRequests) => pullRequests.unlink(threadId, url)),
  "pullRequests.create": ({ threadId }) => PullRequests.use((pullRequests) => pullRequests.create(threadId)),
  "github.auth": () => GitHub.use((github) => github.auth),
  "github.pullRequest": ({ url }) => GitHub.use((github) => github.pullRequest(url)),
  "mcp.connection": ({ threadId }) => McpCredentials.use((mcp) => mcp.connectionFor(threadId)),
  "ports.list": ({ threadId }) => Ports.use((ports) => ports.listForThread(threadId)),
  "ports.kill": ({ pid }) => Ports.use((ports) => ports.kill(pid)),

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
