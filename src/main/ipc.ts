import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron"
import { Cause, Effect, type ManagedRuntime, Schema } from "effect"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import {
  PushEvent,
  type RpcEnvelope,
  type RpcMethod,
  RpcMethods,
  type RpcRequest,
  type RpcResponse,
} from "../shared/contract.ts"
import { AgentRunner } from "./services/AgentRunner.ts"
import { Messages } from "./services/Messages.ts"
import { McpServer } from "./mcp/index.ts"
import { Ports } from "./services/Ports.ts"
import { Projects } from "./services/Projects.ts"
import { PullRequests } from "./services/PullRequests.ts"
import { Secrets } from "./services/Secrets.ts"
import { Settings } from "./services/Settings.ts"
import { Threads } from "./services/Threads.ts"
import { Worktrees } from "./services/Worktrees.ts"

type AppServices =
  | Projects
  | Threads
  | Worktrees
  | Settings
  | Messages
  | AgentRunner
  | McpServer
  | PullRequests
  | Secrets
  | Ports

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

const handlers: Handlers = {
  "projects.list": () => Projects.use((projects) => projects.list),
  "projects.create": (input) => Projects.use((projects) => projects.create(input)),
  "projects.update": (input) => Projects.use((projects) => projects.update(input)),
  "projects.delete": ({ id }) => Projects.use((projects) => projects.remove(id)),

  "threads.list": () => Threads.use((threads) => threads.list),
  "threads.create": (input) => Threads.use((threads) => threads.create(input)),
  "threads.update": (input) => Threads.use((threads) => threads.update(input)),
  "threads.delete": ({ id }) => Threads.use((threads) => threads.remove(id)),

  "worktrees.list": () => Worktrees.use((worktrees) => worktrees.list),
  "worktrees.create": (input) => Worktrees.use((worktrees) => worktrees.create(input)),
  "worktrees.remove": ({ id, deleteBranch }) => Worktrees.use((worktrees) => worktrees.remove(id, deleteBranch)),
  "worktrees.changes": ({ id }) => Worktrees.use((worktrees) => worktrees.changes(id)),
  "worktrees.setupLog": ({ id }) => Worktrees.use((worktrees) => Effect.map(worktrees.get(id), (w) => w.setupLog)),
  "worktrees.mergedState": ({ id }) => Worktrees.use((worktrees) => worktrees.pullRequest(id)),
  "threads.settle": ({ threadId }) => Threads.use((threads) => threads.settle(threadId)),
  "projects.currentBranch": ({ id }) => Worktrees.use((worktrees) => worktrees.currentBranch(id)),
  "shell.reveal": ({ path }) => Effect.sync(() => shell.showItemInFolder(path)),

  "settings.get": () => Settings.use((settings) => settings.get),
  "settings.set": (patch) => Settings.use((settings) => settings.set(patch)),

  "models.list": ({ provider }) => AgentRunner.use((runner) => runner.listModels(provider)),

  "dialog.pickFolder": (_, sender) =>
    Effect.promise(async () => {
      const window = BrowserWindow.fromWebContents(sender)
      const options = { properties: ["openDirectory", "createDirectory"] } satisfies Electron.OpenDialogOptions
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }),

  "messages.list": ({ threadId }) => Messages.use((messages) => messages.list(threadId)),
  "threads.send": ({ threadId, prompt }) => AgentRunner.use((runner) => runner.send(threadId, prompt)),
  "threads.steer": ({ threadId, text }) => AgentRunner.use((runner) => runner.steer(threadId, text)),
  "threads.interrupt": ({ threadId }) => AgentRunner.use((runner) => runner.interrupt(threadId)),
  "approvals.respond": ({ requestId, decision }) =>
    AgentRunner.use((runner) => runner.respondApproval(requestId, decision)),
  "approvals.pending": ({ threadId }) => AgentRunner.use((runner) => runner.pendingApprovals(threadId)),

  // mcp
  "secrets.has": ({ name }) => Secrets.use((secrets) => secrets.has(name)),
  "secrets.set": ({ name, value }) => Secrets.use((secrets) => secrets.set(name, value)),
  "secrets.clear": ({ name }) => Secrets.use((secrets) => secrets.clear(name)),
  "pullRequests.list": ({ threadId }) => PullRequests.use((pullRequests) => pullRequests.list(threadId)),
  "pullRequests.unlink": ({ threadId, url }) => PullRequests.use((pullRequests) => pullRequests.unlink(threadId, url)),
  "mcp.url": ({ threadId }) => McpServer.useSync((mcp) => mcp.urlForThread(threadId)),
  "ports.list": ({ threadId }) => Ports.use((ports) => ports.listForThread(threadId)),
  "ports.kill": ({ pid }) => Ports.use((ports) => ports.kill(pid)),
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

export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown>) => {
  ipcMain.handle(RPC_CHANNEL, (event, raw: unknown) => runtime.runPromise(dispatch(raw, event.sender)))
}

const encodePushEvent = Schema.encodeSync(PushEvent)

export const pushEvent = (webContents: WebContents, event: PushEvent) => {
  webContents.send(EVENT_CHANNEL, encodePushEvent(event))
}
