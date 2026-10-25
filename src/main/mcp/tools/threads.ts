import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { ProviderId } from "../../../shared/agent.ts"
import { isThreadBusy, type Message, type Thread, type Worktree } from "../../../shared/domain.ts"
import { AgentRunner } from "../../services/AgentRunner.ts"
import { Events } from "../../services/Events.ts"
import { PullRequests } from "../../services/PullRequests.ts"
import { Threads } from "../../services/Threads.ts"
import { Worktrees } from "../../services/Worktrees.ts"
import * as McpTool from "./tool.ts"

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100

const renderPart = (part: Message["parts"][number]): string | null => {
  switch (part.type) {
    case "text":
    case "questions":
      return part.text
    case "reasoning":
      return null
    case "tool_call":
      return `[tool ${part.name}: ${part.status}]`
    case "file_change":
      return `[edited ${part.path}]`
    case "attachment":
      return `[attachment ${part.attachment.name}]`
    case "compaction":
      return `[context compaction: ${part.compaction.status}]`
    case "account_switch":
      return `[moved to account ${part.to ?? "default"} after a usage limit]`
  }
}

const renderMessage = (message: Message) =>
  [`## ${message.role} (${message.createdAt})`, ...message.parts.flatMap((part) => renderPart(part) ?? [])].join("\n")

/** Facts about a thread, in a tagged block so the agent can tell them from the transcript. */
const renderMetadata = (thread: Thread, pullRequestUrls: ReadonlyArray<string>) =>
  [
    "<metadata>",
    `thread_id: ${thread.id}`,
    `title: ${thread.title}`,
    `status: ${thread.status}`,
    `provider: ${thread.provider}`,
    `model: ${thread.model}`,
    `created_by: ${thread.createdBy}`,
    `created_at: ${thread.createdAt}`,
    `updated_at: ${thread.updatedAt}`,
    ...(pullRequestUrls.length === 0
      ? ["pull_requests: none"]
      : ["pull_requests:", ...pullRequestUrls.map((url) => `- ${url}`)]),
    "</metadata>",
  ].join("\n")

const renderEnvironment = (worktree: Worktree | null) =>
  [
    "<environment>",
    ...(worktree === null
      ? ["workspace: project root"]
      : ["workspace: worktree", `branch: ${worktree.branch}`, `path: ${worktree.path}`]),
    "</environment>",
  ].join("\n")

const TargetThreadId = Schema.String.annotate({ description: "Id of a thread in this project." })

export const ThreadTools = Toolkit.make(
  McpTool.make("create_thread", {
    description:
      "Start another thread in this project and send it a first prompt. It appears in the user's sidebar at once and runs on its own; this call returns its id without waiting for it. Defaults to this thread's provider and model. Pass `worktree` to run it in a new git worktree. Follow up with read_thread to check on it, send_to_thread to steer it, and stop_thread to interrupt it.",
    parameters: Schema.Struct({
      title: Schema.String.annotate({ description: "Shown in the sidebar." }),
      prompt: Schema.String.annotate({ description: "The new thread's first user message." }),
      provider: Schema.optionalKey(ProviderId),
      model: Schema.optionalKey(Schema.String.annotate({ description: "Model id for that provider." })),
      worktree: Schema.optionalKey(
        Schema.Struct({
          branch: Schema.String.annotate({ description: "Branch to create for the worktree." }),
          baseRef: Schema.String.annotate({ description: "Ref the branch forks from, for example main." }),
        }),
      ),
    }),
  }),
  McpTool.make("list_threads", {
    description:
      "List the threads in this project that are not archived: id, title, status, provider, model, who created it, and its worktree branch. `self` marks this thread.",
  }),
  McpTool.make("read_thread", {
    description:
      "Read another thread of this project: its status, agent and model, workspace, linked pull requests, whether it is waiting on the user, and its latest messages.",
    parameters: Schema.Struct({
      threadId: TargetThreadId,
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_READ_LIMIT })).annotate({
          description: `Latest messages to return, 1-${MAX_READ_LIMIT}. Defaults to ${DEFAULT_READ_LIMIT}.`,
        }),
      ),
    }),
  }),
  McpTool.make("send_to_thread", {
    description:
      "Send a message to another thread of this project. A running thread gets it as steering input in its current turn; an idle one starts a new turn with it.",
    parameters: Schema.Struct({
      threadId: TargetThreadId,
      prompt: Schema.String.annotate({ description: "The user message to send." }),
    }),
  }),
  McpTool.make("stop_thread", {
    description: "Interrupt the running turn of another thread in this project. Does nothing if it is idle.",
    parameters: Schema.Struct({ threadId: TargetThreadId }),
  }),
)

export const threadToolsLayer = ThreadTools.toLayer(
  Effect.gen(function* () {
    const runner = yield* AgentRunner
    const threads = yield* Threads
    const events = yield* Events
    const worktrees = yield* Worktrees
    const pullRequests = yield* PullRequests

    /** A thread of the caller's project, so an agent cannot reach into another project's threads. */
    const projectThread = (targetId: string) =>
      Effect.gen(function* () {
        const caller = yield* threads.get(yield* McpTool.CallingThread)
        const target = yield* threads
          .get(targetId)
          .pipe(
            Effect.catchTag("NotFoundError", () => Effect.fail({ message: `Thread ${targetId} no longer exists.` })),
          )
        if (target.projectId !== caller.projectId) {
          return yield* Effect.fail({ message: `Thread ${targetId} is not in this project.` })
        }
        return target
      })

    const peerThread = (targetId: string) =>
      Effect.flatMap(McpTool.CallingThread, (callerId) =>
        targetId === callerId
          ? Effect.fail({ message: "That is this thread. Use your own turn instead." })
          : projectThread(targetId),
      )

    return ThreadTools.of({
      create_thread: ({ title, prompt, provider, model, worktree }) =>
        Effect.gen(function* () {
          const threadId = yield* McpTool.CallingThread
          const caller = yield* threads.get(threadId)
          const sameProvider = provider === undefined || provider === caller.provider
          if (model === undefined && !sameProvider) {
            return yield* Effect.fail({ message: "Pass `model` when `provider` differs from this thread's." })
          }
          const thread = yield* threads.create({
            projectId: caller.projectId,
            title,
            provider: provider ?? caller.provider,
            model: model ?? caller.model,
            worktree,
            createdBy: `thread:${threadId}`,
          })
          yield* events.publish({ type: "thread.updated", thread })
          yield* runner.send(thread.id, prompt, []).pipe(
            Effect.mapError((error) => ({
              message: `Created thread ${thread.id} but could not start its first turn: ${error.message}`,
            })),
          )
          return `Created thread ${thread.id} "${thread.title}" and sent it the prompt.`
        }),
      list_threads: () =>
        Effect.gen(function* () {
          const threadId = yield* McpTool.CallingThread
          const caller = yield* threads.get(threadId)
          const all = yield* threads.list
          const branches = new Map(
            (yield* worktrees.list)
              .filter((worktree) => worktree.status !== "removed")
              .map((worktree) => [worktree.id, worktree.branch]),
          )
          const listed = all
            .filter((thread) => thread.projectId === caller.projectId && thread.status !== "archived")
            .map((thread) => ({
              id: thread.id,
              title: thread.title,
              status: thread.status,
              provider: thread.provider,
              model: thread.model,
              createdBy: thread.createdBy,
              branch: (thread.worktreeId && branches.get(thread.worktreeId)) ?? null,
              ...(thread.id === threadId ? { self: true } : {}),
            }))
          return JSON.stringify(listed)
        }),
      read_thread: ({ threadId: targetId, limit }) =>
        Effect.gen(function* () {
          const target = yield* projectThread(targetId)
          const transcript = yield* runner.transcript(targetId)
          const worktree =
            target.worktreeId === null
              ? null
              : yield* worktrees
                  .get(target.worktreeId)
                  .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)))
          const links = yield* pullRequests.list(targetId)
          const waiting = [
            ...transcript.approvals.map((request) => `- approval: ${request.title}`),
            ...transcript.questions.flatMap((request) =>
              request.questions.map((question) => `- question: ${question.question}`),
            ),
            ...transcript.secretRequests.map((request) => `- secret: ${request.name}`),
          ]
          const messages = transcript.messages.slice(-(limit ?? DEFAULT_READ_LIMIT))
          return [
            renderMetadata(
              target,
              links.map((link) => link.url),
            ),
            renderEnvironment(worktree),
            ...(waiting.length > 0 ? ["Waiting on the user for:", ...waiting] : []),
            "",
            messages.length === 0 ? "No messages yet." : messages.map(renderMessage).join("\n\n"),
          ].join("\n")
        }),
      send_to_thread: ({ threadId: targetId, prompt }) =>
        Effect.gen(function* () {
          const target = yield* peerThread(targetId)
          if (isThreadBusy(target.status)) {
            yield* runner.steer(targetId, prompt, [])
            return `Steered the running turn of thread ${targetId}.`
          }
          yield* runner.send(targetId, prompt, [])
          return `Started a new turn on thread ${targetId}.`
        }),
      stop_thread: ({ threadId: targetId }) =>
        peerThread(targetId).pipe(
          Effect.andThen(runner.interrupt(targetId)),
          Effect.as(`Interrupted thread ${targetId}.`),
        ),
    })
  }),
)
