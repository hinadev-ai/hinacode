import { Schema } from "effect"
import { AgentEvent, ApprovalDecision, ApprovalRequest, ModelInfo, ProviderId } from "./agent.ts"
import {
  Locale, Message,
  Project,
  PullRequestState,
  Settings,
  Thread,
  ThreadStatus,
  Worktree,
  WorktreeChanges,
} from "./domain.ts"

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
    Schema.Struct({
      projectId: Schema.String,
      title: Schema.String,
      provider: ProviderId,
      model: Schema.String,
      /** Run the thread in a new worktree on `branch`, forked from `baseRef`. */
      worktree: Schema.optional(Schema.Struct({ branch: Schema.String, baseRef: Schema.String })),
    }),
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
  "worktrees.create": rpc(
    Schema.Struct({ projectId: Schema.String, branch: Schema.String, baseRef: Schema.String }),
    Worktree,
  ),
  /** `ifMerged` deletes the branch only when it is merged into the base ref; `force` always does. */
  "worktrees.remove": rpc(
    Schema.Struct({ id: Schema.String, deleteBranch: Schema.Literals(["keep", "ifMerged", "force"]) }),
    Worktree,
  ),
  "worktrees.changes": rpc(Schema.Struct({ id: Schema.String }), WorktreeChanges),
  "worktrees.setupLog": rpc(Schema.Struct({ id: Schema.String }), Schema.String),
  /** The branch's GitHub pull request via `gh`, or null when there is none. */
  "worktrees.mergedState": rpc(Schema.Struct({ id: Schema.String }), Schema.NullOr(PullRequestState)),
  /** Marks the thread settled and removes its worktree. */
  "threads.settle": rpc(Schema.Struct({ threadId: Schema.String }), Thread),
  "projects.currentBranch": rpc(Schema.Struct({ id: Schema.String }), Schema.String),
  /** Shows the path in the OS file manager. */
  "shell.reveal": rpc(Schema.Struct({ path: Schema.String }), Schema.Void),

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

  // chat
  "messages.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(Message)),
  /** Starts a turn and returns once it is running; progress arrives as `message.created` and `thread.event`. */
  "threads.send": rpc(Schema.Struct({ threadId: Schema.String, prompt: Schema.String }), Schema.Void),
  "threads.interrupt": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Void),
  "approvals.respond": rpc(Schema.Struct({ requestId: Schema.String, decision: ApprovalDecision }), Schema.Void),
  "approvals.pending": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(ApprovalRequest)),

  // steering
  /** Adds input to the running turn; starts a turn like `threads.send` when none is running. */
  "threads.steer": rpc(Schema.Struct({ threadId: Schema.String, text: Schema.String }), Schema.Void),
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
  Schema.Struct({ type: Schema.Literal("message.created"), message: Message }),
  /** A message replaced outside the event fold, e.g. an assistant message closed by a steer. */
  Schema.Struct({ type: Schema.Literal("message.updated"), message: Message }),
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
