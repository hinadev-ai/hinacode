import { Schema } from "effect"
import { AgentEvent, ApprovalDecision, ApprovalRequest, ModelInfo, ProviderId } from "./agent.ts"
import {
  Attachment,
  Automation,
  AutomationRun,
  AutomationTrigger,
  Locale,
  Message,
  OpenPort,
  Project,
  PullRequestState,
  PullRequestLink,
  Settings,
  Thread,
  ThreadStatus,
  Worktree,
  WorktreeChanges,
} from "./domain.ts"

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
      automations: Schema.optional(Settings.fields.automations),
    }),
    Settings,
  ),

  "models.list": rpc(Schema.Struct({ provider: ProviderId }), Schema.Array(ModelInfo)),

  /** Opens the native folder picker. Null when the user cancels. */
  "dialog.pickFolder": rpc(Schema.Void, Schema.NullOr(Schema.String)),

  "messages.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(Message)),
  /** Starts a turn and returns once it is running; progress arrives as `message.created` and `thread.event`. */
  "threads.send": rpc(
    Schema.Struct({
      threadId: Schema.String,
      prompt: Schema.String,
      attachments: Schema.optional(Schema.Array(Attachment)),
    }),
    Schema.Void,
  ),
  "threads.interrupt": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Void),
  "approvals.respond": rpc(Schema.Struct({ requestId: Schema.String, decision: ApprovalDecision }), Schema.Void),
  "approvals.pending": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(ApprovalRequest)),
  /** Secrets never cross back to the renderer; it can only ask whether one is set. */
  "secrets.has": rpc(Schema.Struct({ name: Schema.String }), Schema.Boolean),
  "secrets.set": rpc(Schema.Struct({ name: Schema.String, value: Schema.String }), Schema.Void),
  "secrets.clear": rpc(Schema.Struct({ name: Schema.String }), Schema.Void),
  "pullRequests.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(PullRequestLink)),
  "pullRequests.unlink": rpc(Schema.Struct({ threadId: Schema.String, url: Schema.String }), Schema.Void),
  /** The built-in MCP server URL handed to agents running in this thread. */
  "mcp.url": rpc(Schema.Struct({ threadId: Schema.String }), Schema.String),

  "ports.list": rpc(Schema.Struct({ threadId: Schema.String }), Schema.Array(OpenPort)),
  "ports.kill": rpc(Schema.Struct({ pid: Schema.Number }), Schema.Void),

  /** Adds input to the running turn; starts a turn like `threads.send` when none is running. */
  "threads.steer": rpc(
    Schema.Struct({
      threadId: Schema.String,
      text: Schema.String,
      attachments: Schema.optional(Schema.Array(Attachment)),
    }),
    Schema.Void,
  ),

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
  "automations.webhookUrl": rpc(
    Schema.Struct({ id: Schema.String }),
    Schema.Struct({ url: Schema.String, listenError: Schema.NullOr(Schema.String) }),
  ),
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
  Schema.Struct({
    type: Schema.Literal("thread.pullRequests"),
    threadId: Schema.String,
    links: Schema.Array(PullRequestLink),
  }),
  /** A message replaced outside the event fold, e.g. an assistant message closed by a steer. */
  Schema.Struct({ type: Schema.Literal("message.updated"), message: Message }),
  /** An automation run was recorded or changed status. */
  Schema.Struct({ type: Schema.Literal("automation.run"), run: AutomationRun }),
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
  /** Absolute path of a dropped or picked `File`; sandboxed renderers have no `File.path`. */
  readonly pathForFile: (file: File) => string
}
