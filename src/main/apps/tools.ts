import { Context, Effect, Layer, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { ProviderId } from "../../shared/agent.ts"
import { isThreadBusy } from "../../shared/domain.ts"
import {
  Effort,
  listedThread,
  NewWorktree,
  projectLabels,
  ReadLimit,
  renderThread,
  SearchLimit,
  searchThreads,
} from "../mcp/tools/threadViews.ts"
import * as McpTool from "../mcp/tools/tool.ts"
import { AgentRunner } from "../services/AgentRunner.ts"
import { Events } from "../services/Events.ts"
import { newThreadOptions, newThreadProvider } from "../services/newThread.ts"
import { Projects } from "../services/Projects.ts"
import { PullRequests } from "../services/PullRequests.ts"
import { Search } from "../services/Search.ts"
import type { Settings } from "../services/Settings.ts"
import { Threads } from "../services/Threads.ts"
import { Worktrees } from "../services/Worktrees.ts"

export class CallingApp extends Context.Service<CallingApp, string>()("hinacode/apps/CallingApp") {}

const AppTool = McpTool.toolsFor(CallingApp, {
  resolve: Effect.serviceOption(CallingApp),
  invalid: McpTool.text("This app is not connected to HinaCode.", true),
})

const ThreadId = Schema.String.annotate({ description: "Id of a thread, from list_threads or search_threads." })

const AppTools = Toolkit.make(
  AppTool.make("list_projects", {
    description:
      "List the projects on the developer's machine. Returns JSON with each project's id, name and folder path. Pass an id to list_threads or create_thread.",
  }),
  AppTool.make("list_threads", {
    description:
      "List the threads that are not archived, across every project or in one. A thread is one conversation with a coding agent. Returns JSON with each thread's id, title, status, projectId, provider, model, who created it, and its git worktree branch when it has one.",
    parameters: Schema.Struct({
      projectId: Schema.optionalKey(
        Schema.String.annotate({ description: "Only list this project's threads. An id from list_projects." }),
      ),
    }),
  }),
  AppTool.make("search_threads", {
    description:
      "Search every project's threads, archived ones included, by title and message text. Returns JSON with each thread's id, title, status and project, and a snippet of its latest matching message when one matches. Title matches come first, then threads with the newest matching message.",
    parameters: Schema.Struct({
      query: Schema.String.annotate({ description: "Text to find." }),
      limit: Schema.optionalKey(SearchLimit),
    }),
  }),
  AppTool.make("read_thread", {
    description:
      "Read one thread. Returns text: its status, agent and model, project and workspace, linked pull requests, what it is waiting on the developer for (approvals, questions and secrets can only be answered in HinaCode), and its latest messages.",
    parameters: Schema.Struct({ threadId: ThreadId, limit: Schema.optionalKey(ReadLimit) }),
  }),
  AppTool.make("create_thread", {
    description:
      "Start a thread in a project and send it a first prompt. A coding agent then works on the prompt in that project's folder on the developer's machine, and can run commands there. Returns the new thread's id at once, without waiting for the agent. Uses the developer's default agent and model unless `provider` and `model` are passed. Pass `worktree` to run it in a new git worktree. Follow up with read_thread to check on it, send_to_thread to steer it and stop_thread to interrupt it.",
    parameters: Schema.Struct({
      projectId: Schema.String.annotate({ description: "Id of the project to work in, from list_projects." }),
      title: Schema.String.annotate({ description: "Shown in the developer's sidebar." }),
      prompt: Schema.String.annotate({ description: "The thread's first user message." }),
      provider: Schema.optionalKey(ProviderId),
      model: Schema.optionalKey(Schema.String.annotate({ description: "Model id for that provider." })),
      effort: Schema.optionalKey(Effort),
      worktree: Schema.optionalKey(NewWorktree),
    }),
  }),
  AppTool.make("send_to_thread", {
    description:
      "Send a user message to a thread. A running thread gets it as steering input in its current turn, and an idle one starts a new turn with it. Returns which of the two happened. `effort` applies from this message on. `model` can only change before the thread's first turn starts.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      prompt: Schema.String.annotate({ description: "The user message to send." }),
      model: Schema.optionalKey(Schema.String.annotate({ description: "Model id for the thread's provider." })),
      effort: Schema.optionalKey(Effort),
    }),
  }),
  AppTool.make("stop_thread", {
    description: "Interrupt a thread's running turn. Does nothing if it is idle. Returns a confirmation.",
    parameters: Schema.Struct({ threadId: ThreadId }),
  }),
)

const appToolsLayer = AppTools.toLayer(
  Effect.gen(function* () {
    const runner = yield* AgentRunner
    const threads = yield* Threads
    const events = yield* Events
    const worktrees = yield* Worktrees
    const pullRequests = yield* PullRequests
    const projects = yield* Projects
    const search = yield* Search
    const defaults = yield* Effect.context<Settings | AgentRunner>()

    return AppTools.of({
      list_projects: () =>
        Effect.map(projects.list, (all) =>
          JSON.stringify(all.map((project) => ({ id: project.id, name: project.name, path: project.rootPath }))),
        ),
      list_threads: ({ projectId }) =>
        Effect.gen(function* () {
          if (projectId !== undefined) yield* projects.get(projectId)
          const branches = new Map(
            (yield* worktrees.list)
              .filter((worktree) => worktree.status !== "removed")
              .map((worktree) => [worktree.id, worktree.branch]),
          )
          return JSON.stringify(
            (yield* threads.list)
              .filter((thread) => projectId === undefined || thread.projectId === projectId)
              .filter((thread) => thread.status !== "archived" && thread.status !== "draft")
              .map((thread) => ({
                ...listedThread(thread, thread.worktreeId && branches.get(thread.worktreeId)),
                projectId: thread.projectId,
              })),
          )
        }),
      search_threads: ({ query, limit }) =>
        Effect.gen(function* () {
          const [all, labels] = yield* Effect.all([threads.list, projectLabels(projects)])
          return yield* searchThreads({ threads: all, labels, search }, query, { limit })
        }),
      read_thread: ({ threadId, limit }) =>
        Effect.gen(function* () {
          const thread = yield* threads.get(threadId)
          const { worktreeId } = thread
          const [transcript, worktree, links, labels] = yield* Effect.all([
            runner.transcript(threadId),
            worktreeId === null
              ? Effect.succeed(null)
              : worktrees.get(worktreeId).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null))),
            pullRequests.list(threadId),
            projectLabels(projects),
          ])
          return renderThread({
            thread,
            place: { here: true, project: labels.get(thread.projectId) },
            transcript,
            worktree,
            pullRequestUrls: links.map((link) => link.url),
            limit,
          })
        }),
      create_thread: ({ projectId, title, prompt, provider: chosenProvider, model, effort, worktree }) =>
        Effect.gen(function* () {
          const provider = chosenProvider ?? (yield* Effect.provide(newThreadProvider, defaults))
          const options =
            model === undefined
              ? yield* Effect.provide(newThreadOptions(provider), defaults)
              : { model, effort: undefined, fastMode: undefined }
          if (options.model === "") {
            return yield* Effect.fail({
              message: `HinaCode has no default model for ${provider}. Pass \`provider\` and \`model\`.`,
            })
          }
          const thread = yield* threads.create({
            projectId,
            title,
            provider,
            ...options,
            effort: effort ?? options.effort,
            worktree,
            createdBy: `app:${yield* CallingApp}`,
          })
          yield* events.publish({ type: "thread.updated", thread })
          yield* runner.send(thread.id, prompt, []).pipe(
            Effect.mapError((error) => ({
              message: `Created thread ${thread.id} but could not start its first turn: ${error.message}`,
            })),
          )
          return `Created thread ${thread.id} "${thread.title}" and sent it the prompt.`
        }),
      send_to_thread: ({ threadId, prompt, model, effort }) =>
        Effect.gen(function* () {
          const target = yield* threads.get(threadId)
          if (model !== undefined && model !== target.model && target.providerSessionId !== null) {
            return yield* Effect.fail({
              message: `Thread ${threadId} has started, so its model stays ${target.model}. Pass only \`effort\`.`,
            })
          }
          if (model !== undefined || effort !== undefined) {
            const thread = yield* threads.update({ id: threadId, model, effort })
            yield* events.publish({ type: "thread.updated", thread })
          }
          yield* runner.steer(threadId, prompt, [])
          return isThreadBusy(target.status)
            ? `Steered the running turn of thread ${threadId}.`
            : `Started a new turn on thread ${threadId}.`
        }),
      stop_thread: ({ threadId }) =>
        Effect.gen(function* () {
          yield* threads.get(threadId)
          yield* runner.interrupt(threadId)
          return `Interrupted thread ${threadId}.`
        }),
    })
  }),
)

export const layer = Layer.effectDiscard(AppTool.register(AppTools)).pipe(Layer.provide(appToolsLayer))
