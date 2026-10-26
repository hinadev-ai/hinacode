import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { ProviderId } from "../../../shared/agent.ts"
import { isThreadBusy, type Message, type Thread, type Worktree } from "../../../shared/domain.ts"
import { Peers } from "../../remote/peers.ts"
import { AgentRunner } from "../../services/AgentRunner.ts"
import { Events } from "../../services/Events.ts"
import { Projects } from "../../services/Projects.ts"
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

const renderEnvironment = (worktree: Worktree | null, here: boolean) =>
  [
    "<environment>",
    ...(here ? [] : ["machine: another one, so its paths are not on this machine"]),
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
      "List the threads in this project that are not archived: id, title, status, provider, model, who created it, and its worktree branch. `self` marks this thread. Threads of the same GitHub repository on the user's other machines are included and marked `otherMachine`.",
  }),
  McpTool.make("read_thread", {
    description:
      "Read another thread of this project, on this machine or on another of the user's machines in the same GitHub repository: its status, agent and model, workspace, linked pull requests, whether it is waiting on the user, and its latest messages.",
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
    const projects = yield* Projects
    const peers = yield* Peers

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

    /** Project ids are per machine, so a project on another machine is this one when it checks out the same repository. */
    const repositoryOf = (projectId: string) =>
      Effect.map(projects.listWithRepositories, (all) => all.find((project) => project.id === projectId)?.repository)

    /** Threads of `repository` on the user's other machines, which can repeat this machine's own. */
    const elsewhere = (repository: string) =>
      Effect.gen(function* () {
        const [known, all] = yield* Effect.all(
          [peers.ask("projects.list", undefined), peers.ask("threads.list", undefined)],
          { concurrency: "unbounded" },
        )
        const same = new Set(known.filter((project) => project.repository === repository).map((project) => project.id))
        return all.filter((thread) => same.has(thread.projectId))
      })

    /** A thread of the caller's project on this machine, else one of its repository on another machine. */
    const readableThread = (targetId: string) =>
      Effect.gen(function* () {
        const here = yield* threads
          .get(targetId)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
        if (here !== undefined) return { thread: yield* projectThread(targetId), here: true }
        const caller = yield* threads.get(yield* McpTool.CallingThread)
        const repository = yield* repositoryOf(caller.projectId)
        const gone = { message: `Thread ${targetId} no longer exists.` }
        if (repository === undefined) return yield* Effect.fail(gone)
        const found = (yield* elsewhere(repository).pipe(
          Effect.mapError((error) => ({
            message: `Thread ${targetId} is not on this machine, and the other machines are out of reach: ${error.message}`,
          })),
        )).find((thread) => thread.id === targetId)
        if (found === undefined) return yield* Effect.fail(gone)
        return { thread: found, here: false }
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
          const local = all.filter((thread) => thread.projectId === caller.projectId)
          const repository = yield* repositoryOf(caller.projectId)
          const others =
            repository === undefined ? [] : yield* elsewhere(repository).pipe(Effect.catch(() => Effect.succeed([])))
          const otherBranches = new Map(
            others.length === 0
              ? []
              : (yield* peers.ask("worktrees.list", undefined).pipe(Effect.catch(() => Effect.succeed([])))).map(
                  (worktree) => [worktree.id, worktree.branch],
                ),
          )
          const localIds = new Set(all.map((thread) => thread.id))
          const listed = [
            ...local.map((thread) => ({ thread, here: true })),
            ...others.filter((thread) => !localIds.has(thread.id)).map((thread) => ({ thread, here: false })),
          ]
            .filter(({ thread }) => thread.status !== "archived")
            .map(({ thread, here }) => ({
              id: thread.id,
              title: thread.title,
              status: thread.status,
              provider: thread.provider,
              model: thread.model,
              createdBy: thread.createdBy,
              branch: (thread.worktreeId && (here ? branches : otherBranches).get(thread.worktreeId)) ?? null,
              ...(thread.id === threadId ? { self: true } : {}),
              ...(here ? {} : { otherMachine: true }),
            }))
          return JSON.stringify(listed)
        }),
      read_thread: ({ threadId: targetId, limit }) =>
        Effect.gen(function* () {
          const { thread: target, here } = yield* readableThread(targetId)
          const { worktreeId } = target
          const [transcript, worktree, links] = here
            ? yield* Effect.all([
                runner.transcript(targetId),
                worktreeId === null
                  ? Effect.succeed(null)
                  : worktrees.get(worktreeId).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null))),
                pullRequests.list(targetId),
              ])
            : yield* Effect.all(
                [
                  peers.ask("threads.transcript", { threadId: targetId, compact: true }),
                  worktreeId === null
                    ? Effect.succeed(null)
                    : Effect.map(
                        peers.ask("worktrees.list", undefined),
                        (all) => all.find((worktree) => worktree.id === worktreeId) ?? null,
                      ),
                  peers.ask("pullRequests.list", { threadId: targetId }),
                ],
                { concurrency: "unbounded" },
              )
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
            renderEnvironment(worktree, here),
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
