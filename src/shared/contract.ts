import { Schema } from "effect"
import { AgentEvent, ModelInfo, ProviderId } from "./agent.ts"
import { Locale, Project, PullRequestLink, Settings, Thread, ThreadStatus, Worktree } from "./domain.ts"

const rpc = <Req extends Schema.Top, Res extends Schema.Top>(request: Req, response: Res) => ({ request, response })

/** Every renderer -> main call. Both sides decode what they receive with these schemas. */
export const RpcMethods = {
  "projects.list": rpc(Schema.Void, Schema.Array(Project)),
  "projects.create": rpc(
    Schema.Struct({ name: Schema.String, rootPath: Schema.String, setupScript: Schema.NullOr(Schema.String) }),
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
  "threads.create": rpc(
    Schema.Struct({ projectId: Schema.String, title: Schema.String, provider: ProviderId, model: Schema.String }),
    Thread,
  ),
  "threads.update": rpc(
    Schema.Struct({
      id: Schema.String,
      title: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      status: Schema.optional(ThreadStatus),
      sortIndex: Schema.optional(Schema.Number),
    }),
    Thread,
  ),
  "threads.delete": rpc(Schema.Struct({ id: Schema.String }), Schema.Void),

  "worktrees.list": rpc(Schema.Void, Schema.Array(Worktree)),

  "settings.get": rpc(Schema.Void, Settings),
  "settings.set": rpc(
    Schema.Struct({
      locale: Schema.optional(Locale),
      keybindings: Schema.optional(Settings.fields.keybindings),
      defaultModel: Schema.optional(Settings.fields.defaultModel),
    }),
    Settings,
  ),

  "models.list": rpc(Schema.Struct({ provider: ProviderId }), Schema.Array(ModelInfo)),

  /** Opens the native folder picker. Null when the user cancels. */
  "dialog.pickFolder": rpc(Schema.Void, Schema.NullOr(Schema.String)),

  // mcp
  /** Secrets never cross back to the renderer; it can only ask whether one is set. */
  "secrets.has": rpc(Schema.Struct({ name: Schema.String }), Schema.Boolean),
  "secrets.set": rpc(Schema.Struct({ name: Schema.String, value: Schema.String }), Schema.Void),
  "secrets.clear": rpc(Schema.Struct({ name: Schema.String }), Schema.Void),
  "pullRequests.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(PullRequestLink)),
  "pullRequests.unlink": rpc(Schema.Struct({ threadId: Schema.String, url: Schema.String }), Schema.Void),
  /** The built-in MCP server URL handed to agents running in this thread. */
  "mcp.url": rpc(Schema.Struct({ threadId: Schema.String }), Schema.String),
}

export type RpcMethod = keyof typeof RpcMethods
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

/** Main -> renderer pushes on the `event` channel. */
export const PushEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("thread.updated"), thread: Thread }),
  Schema.Struct({ type: Schema.Literal("worktree.updated"), worktree: Worktree }),
  Schema.Struct({ type: Schema.Literal("worktree.setupLog"), id: Schema.String, chunk: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thread.event"), threadId: Schema.String, event: AgentEvent }),
  Schema.Struct({
    type: Schema.Literal("thread.pullRequests"),
    threadId: Schema.String,
    links: Schema.Array(PullRequestLink),
  }),
])
export type PushEvent = typeof PushEvent.Type

/** The bridge preload exposes as `window.kkcode`. */
export interface KkcodeBridge {
  readonly rpc: <M extends RpcMethod>(
    method: M,
    payload: RpcRequestEncoded<M>,
  ) => Promise<RpcEnvelope<RpcResponseEncoded<M>>>
  /** Returns an unsubscribe function. */
  readonly onEvent: (listener: (event: typeof PushEvent.Encoded) => void) => () => void
}
