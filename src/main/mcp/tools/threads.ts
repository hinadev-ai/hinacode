import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { ProviderId } from "../../../shared/agent.ts"
import {
  isThreadBusy,
  type Machine,
  type Message,
  type PullRequest,
  type Thread,
  type Worktree,
} from "../../../shared/domain.ts"
import { RemoteAccess } from "../../remote/access.ts"
import { Peers } from "../../remote/peers.ts"
import { AgentRunner } from "../../services/AgentRunner.ts"
import { Events } from "../../services/Events.ts"
import { GitHub } from "../../services/GitHub.ts"
import { Projects } from "../../services/Projects.ts"
import { PullRequests } from "../../services/PullRequests.ts"
import { Search } from "../../services/Search.ts"
import { Threads } from "../../services/Threads.ts"
import { Worktrees } from "../../services/Worktrees.ts"
import * as McpTool from "./tool.ts"

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100

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
    case "agent_switch":
      return `[agent switched: ${part.from} → ${part.to}]`
    case "session_import":
      return part.history === "replayed"
        ? `[imported ${part.provider} session]`
        : `[imported ${part.provider} session, earlier history not shown]`
  }
}

const renderMessage = (message: Message) =>
  [`## ${message.role} (${message.createdAt})`, ...message.parts.flatMap((part) => renderPart(part) ?? [])].join("\n")

interface LinkedPullRequest {
  readonly url: string
  readonly detail: PullRequest | null
}

const renderPullRequest = ({ url, detail }: LinkedPullRequest) =>
  detail === null
    ? `- ${url}`
    : `- ${url}: ${detail.status}, checks ${detail.checks ?? "none"}, review ${detail.review ?? "none"}, ${detail.mergeable}`

const renderMetadata = (thread: Thread, pullRequests: ReadonlyArray<LinkedPullRequest>) =>
  [
    "<metadata>",
    `thread_id: ${thread.id}`,
    `title: ${thread.title}`,
    `status: ${thread.status}`,
    `provider: ${thread.provider}`,
    `model: ${thread.model}`,
    `effort: ${thread.effort ?? "default"}`,
    `created_by: ${thread.createdBy}`,
    `created_at: ${thread.createdAt}`,
    `updated_at: ${thread.updatedAt}`,
    ...(pullRequests.length === 0
      ? ["pull_requests: none"]
      : ["pull_requests:", ...pullRequests.map(renderPullRequest)]),
    "</metadata>",
  ].join("\n")

type Place =
  | { readonly here: true; readonly project?: string }
  | { readonly here: false; readonly machine: MachineRef | undefined }
type MachineRef = Pick<Machine, "id" | "name">
const HERE: Place = { here: true }

const renderEnvironment = (worktree: Worktree | null, place: Place) =>
  [
    "<environment>",
    ...(place.here
      ? place.project === undefined
        ? []
        : [`project: ${place.project}`]
      : [
          place.machine === undefined
            ? "machine: another one, so its paths are not on this machine"
            : `machine: ${place.machine.name} (${place.machine.id}), not this one, so its paths are not here`,
        ]),
    ...(worktree === null
      ? ["workspace: project root"]
      : ["workspace: worktree", `branch: ${worktree.branch}`, `path: ${worktree.path}`]),
    "</environment>",
  ].join("\n")

const TargetThreadId = Schema.String.annotate({
  description:
    "Id of a thread in this project, on this machine or on another of the user's machines. The conductor can pass a thread of any project on this machine.",
})
const AnyThreadId = Schema.String.annotate({
  description: "Id of a thread in any project on this machine, or in this project on another of the user's machines.",
})
const Effort = Schema.String.annotate({ description: "Reasoning effort, such as low, medium or high." })

export const ThreadTools = Toolkit.make(
  McpTool.make("create_thread", {
    description:
      "Start another thread in this project and send it a first prompt. The conductor passes `project` to pick the project. It appears in the user's sidebar at once and runs on its own; this call returns its id without waiting for it. Defaults to this thread's provider and model, and the model's default effort. Pass `worktree` to run it in a new git worktree, and `machine` to run it on another of the user's machines. Follow up with read_thread to check on it, send_to_thread to steer it, and stop_thread to interrupt it.",
    parameters: Schema.Struct({
      project: Schema.optionalKey(
        Schema.String.annotate({
          description: "Id of the project to start it in, from list_projects. Only the conductor can pass it.",
        }),
      ),
      title: Schema.String.annotate({ description: "Shown in the sidebar." }),
      prompt: Schema.String.annotate({ description: "The new thread's first user message." }),
      provider: Schema.optionalKey(ProviderId),
      model: Schema.optionalKey(Schema.String.annotate({ description: "Model id for that provider." })),
      effort: Schema.optionalKey(Effort),
      worktree: Schema.optionalKey(
        Schema.Struct({
          branch: Schema.String.annotate({ description: "Branch to create for the worktree." }),
          baseRef: Schema.String.annotate({ description: "Ref the branch forks from, for example main." }),
        }),
      ),
      machine: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "Id of the machine to run it on, from list_machines. That machine needs a project for this GitHub repository. Defaults to this machine.",
        }),
      ),
    }),
  }),
  McpTool.make("list_projects", {
    description:
      "List the projects on this machine: id, name, folder and GitHub repository. The conductor passes an id to create_thread to start a thread there.",
  }),
  McpTool.make("list_machines", {
    description:
      "List the user's machines that HinaCode connects: id, name, and whether each has a project for this GitHub repository, which create_thread needs to run a thread there. `self` marks this machine. When a machine has no such project, ask the user to add it there.",
  }),
  McpTool.make("list_threads", {
    description:
      "List the threads in this project that are not archived: id, title, status, provider, model, who created it, and its worktree branch. `self` marks this thread. For the conductor it lists every project on this machine, with each thread's `project`. Threads of the same GitHub repository on the user's other machines are included, with the `machine` they run on.",
  }),
  McpTool.make("search_threads", {
    description:
      "Search the threads of every project on this machine, archived ones included, by title and message text. Returns JSON with each thread's id, title, status and project, a snippet of its latest matching message when one matches, and `self` on this thread. Title matches come first, then threads with the newest matching message. Pass an id to read_thread to read it.",
    parameters: Schema.Struct({
      query: Schema.String.annotate({ description: "Text to find." }),
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT })).annotate({
          description: `Threads to return, 1-${MAX_SEARCH_LIMIT}. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
        }),
      ),
    }),
  }),
  McpTool.make("read_thread", {
    description:
      "Read another thread, of any project on this machine or of this project on another of the user's machines: its status, agent and model, project and workspace, linked pull requests, whether it is waiting on the user, and its latest messages.",
    parameters: Schema.Struct({
      threadId: AnyThreadId,
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_READ_LIMIT })).annotate({
          description: `Latest messages to return, 1-${MAX_READ_LIMIT}. Defaults to ${DEFAULT_READ_LIMIT}.`,
        }),
      ),
    }),
  }),
  McpTool.make("send_to_thread", {
    description:
      "Send a message to another thread of this project, on this machine or on another of the user's machines. The conductor can send to a thread of any project on this machine. A running thread gets it as steering input in its current turn; an idle one starts a new turn with it. `effort` applies from this message on. `model` can only change before the thread's first turn starts.",
    parameters: Schema.Struct({
      threadId: TargetThreadId,
      prompt: Schema.String.annotate({ description: "The user message to send." }),
      model: Schema.optionalKey(Schema.String.annotate({ description: "Model id for the thread's provider." })),
      effort: Schema.optionalKey(Effort),
    }),
  }),
  McpTool.make("stop_thread", {
    description:
      "Interrupt the running turn of another thread in this project, on this machine or on another of the user's machines. The conductor can stop a thread of any project on this machine. Does nothing if it is idle.",
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
    const search = yield* Search
    const github = yield* GitHub
    const peers = yield* Peers
    const { identity } = yield* RemoteAccess

    const projectThread = (targetId: string) =>
      Effect.gen(function* () {
        const caller = yield* threads.get(yield* McpTool.CallingThread)
        const target = yield* threads
          .get(targetId)
          .pipe(
            Effect.catchTag("NotFoundError", () => Effect.fail({ message: `Thread ${targetId} no longer exists.` })),
          )
        if (target.projectId !== caller.projectId && !caller.conductor) {
          return yield* Effect.fail({ message: `Thread ${targetId} is not in this project.` })
        }
        return target
      })

    const projectLabels = Effect.map(
      projects.list,
      (all) => new Map(all.map((project) => [project.id, `${project.name} (${project.rootPath})`])),
    )

    const anyLocalThread = (targetId: string) =>
      Effect.gen(function* () {
        const caller = yield* threads.get(yield* McpTool.CallingThread)
        const target = yield* threads.get(targetId)
        if (target.projectId === caller.projectId) return { thread: target, place: HERE }
        const place: Place = { here: true, project: (yield* projectLabels).get(target.projectId) }
        return { thread: target, place }
      })

    const projectOf = (caller: Thread, project: string | undefined) =>
      Effect.gen(function* () {
        if (project === undefined) {
          return caller.conductor
            ? yield* Effect.fail({ message: "Pass `project`, an id from list_projects." })
            : caller.projectId
        }
        if (!caller.conductor && project !== caller.projectId) {
          return yield* Effect.fail({ message: "Only the conductor can start a thread in another project." })
        }
        const found = yield* projects
          .get(project)
          .pipe(
            Effect.catchTag("NotFoundError", () =>
              Effect.fail({ message: `No project has id ${project}. Call list_projects for the ids.` }),
            ),
          )
        return found.id
      })

    const describePullRequest = (url: string) =>
      github.pullRequest(url).pipe(
        Effect.map((detail): LinkedPullRequest => ({ url, detail })),
        Effect.orElseSucceed((): LinkedPullRequest => ({ url, detail: null })),
      )

    const repositoryOf = (projectId: string) =>
      Effect.map(projects.listWithRepositories, (all) => all.find((project) => project.id === projectId)?.repository)

    const elsewhere = (repository: string) =>
      Effect.gen(function* () {
        const [known, all, machines] = yield* Effect.all(
          [
            peers.ask("projects.list", undefined),
            peers.ask("threads.list", undefined),
            peers.ask("machines.list", undefined).pipe(Effect.orElseSucceed(() => [])),
          ],
          { concurrency: "unbounded" },
        )
        const same = new Set(known.filter((project) => project.repository === repository).map((project) => project.id))
        const machineOf = new Map(
          machines.flatMap(({ id, name, projectIds }) => projectIds.map((projectId) => [projectId, { id, name }])),
        )
        return all
          .filter((thread) => same.has(thread.projectId))
          .map((thread) => ({ thread, machine: machineOf.get(thread.projectId) }))
      })

    const otherMachines = (repository: string | undefined) =>
      Effect.gen(function* () {
        const [known, machines] = yield* Effect.all(
          [peers.ask("projects.list", undefined), peers.ask("machines.list", undefined)],
          { concurrency: "unbounded" },
        )
        const same = new Set(
          known
            .filter((project) => repository !== undefined && project.repository === repository)
            .map((project) => project.id),
        )
        return machines
          .filter((machine) => machine.id !== identity.id)
          .map(({ id, name, projectIds }) => ({
            id,
            name,
            projectIds: projectIds.filter((projectId) => same.has(projectId)),
          }))
      })

    const locate = (targetId: string, scope: "project" | "anyProject") =>
      Effect.gen(function* () {
        const here = yield* threads
          .get(targetId)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
        if (here !== undefined) {
          return scope === "anyProject"
            ? yield* anyLocalThread(targetId)
            : { thread: yield* projectThread(targetId), place: HERE }
        }
        const caller = yield* threads.get(yield* McpTool.CallingThread)
        const repository = yield* repositoryOf(caller.projectId)
        const gone = { message: `Thread ${targetId} no longer exists.` }
        if (repository === undefined) return yield* Effect.fail(gone)
        const found = (yield* elsewhere(repository).pipe(
          Effect.mapError((error) => ({
            message: `Thread ${targetId} is not on this machine, and the other machines are out of reach: ${error.message}`,
          })),
        )).find(({ thread }) => thread.id === targetId)
        if (found === undefined) return yield* Effect.fail(gone)
        const place: Place = { here: false, machine: found.machine }
        return { thread: found.thread, place }
      })

    const peerThread = (targetId: string) =>
      Effect.flatMap(McpTool.CallingThread, (callerId) =>
        targetId === callerId
          ? Effect.fail({ message: "That is this thread. Use your own turn instead." })
          : locate(targetId, "project"),
      )

    return ThreadTools.of({
      create_thread: ({ project, title, prompt, provider, model, effort, worktree, machine }) =>
        Effect.gen(function* () {
          const threadId = yield* McpTool.CallingThread
          const caller = yield* threads.get(threadId)
          const projectId = yield* projectOf(caller, project)
          const sameProvider = provider === undefined || provider === caller.provider
          if (model === undefined && !sameProvider) {
            return yield* Effect.fail({ message: "Pass `model` when `provider` differs from this thread's." })
          }
          const options = {
            title,
            provider: provider ?? caller.provider,
            model: model ?? caller.model,
            effort,
            worktree,
            createdBy: `thread:${threadId}`,
          }
          if (machine !== undefined && machine !== identity.id) {
            const repository = yield* repositoryOf(projectId)
            if (repository === undefined) {
              return yield* Effect.fail({
                message: "This project has no GitHub origin, so its threads can only run on this machine.",
              })
            }
            const target = (yield* otherMachines(repository).pipe(
              Effect.mapError((error) => ({ message: `The other machines are out of reach: ${error.message}` })),
            )).find(({ id }) => id === machine)
            if (target === undefined) {
              return yield* Effect.fail({ message: `No machine has id ${machine}. Call list_machines for the ids.` })
            }
            const remoteProjectId = target.projectIds[0]
            if (remoteProjectId === undefined) {
              return yield* Effect.fail({
                message: `${target.name} has no project for ${repository}. Ask the user to add ${repository} as a project on ${target.name}, then try again.`,
              })
            }
            const thread = yield* peers.ask("threads.create", { projectId: remoteProjectId, ...options })
            if (worktree !== undefined && thread.worktreeId === null) {
              return yield* Effect.fail({
                message: `${target.name} runs an older HinaCode that ignores \`worktree\`, so thread ${thread.id} was created there without one and not started. Ask the user to update HinaCode on ${target.name}.`,
              })
            }
            yield* peers.ask("threads.steer", { threadId: thread.id, text: prompt }).pipe(
              Effect.mapError((error) => ({
                message: `Created thread ${thread.id} on ${target.name} but could not start its first turn: ${error.message}`,
              })),
            )
            return `Created thread ${thread.id} "${thread.title}" on ${target.name} and sent it the prompt.`
          }
          const thread = yield* threads.create({ projectId, ...options })
          yield* events.publish({ type: "thread.updated", thread })
          yield* runner.send(thread.id, prompt, []).pipe(
            Effect.mapError((error) => ({
              message: `Created thread ${thread.id} but could not start its first turn: ${error.message}`,
            })),
          )
          return `Created thread ${thread.id} "${thread.title}" and sent it the prompt.`
        }),
      list_projects: () =>
        Effect.map(projects.listWithRepositories, (all) =>
          JSON.stringify(
            all
              .filter((project) => project.kind === "folder")
              .map(({ id, name, rootPath, repository }) => ({
                id,
                name,
                path: rootPath,
                repository: repository ?? null,
              })),
          ),
        ).pipe(Effect.mapError((error) => ({ message: error.message }))),
      list_machines: () =>
        Effect.gen(function* () {
          const caller = yield* threads.get(yield* McpTool.CallingThread)
          const repository = yield* repositoryOf(caller.projectId)
          const others = yield* otherMachines(repository).pipe(Effect.catch(() => Effect.succeed([])))
          return JSON.stringify([
            { id: identity.id, name: identity.name, self: true, hasProject: true },
            ...others.map(({ id, name, projectIds }) => ({ id, name, hasProject: projectIds.length > 0 })),
          ])
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
          const local = caller.conductor ? all : all.filter((thread) => thread.projectId === caller.projectId)
          const labels = caller.conductor ? yield* projectLabels : new Map<string, string>()
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
            ...local.map((thread) => ({ thread, place: HERE })),
            ...others
              .filter(({ thread }) => !localIds.has(thread.id))
              .map(({ thread, machine }): { thread: Thread; place: Place } => ({
                thread,
                place: { here: false, machine },
              })),
          ]
            .filter(({ thread }) => thread.status !== "archived" && thread.status !== "draft")
            .map(({ thread, place }) => ({
              id: thread.id,
              title: thread.title,
              status: thread.status,
              provider: thread.provider,
              model: thread.model,
              createdBy: thread.createdBy,
              branch: (thread.worktreeId && (place.here ? branches : otherBranches).get(thread.worktreeId)) ?? null,
              ...(caller.conductor ? { project: labels.get(thread.projectId) ?? thread.projectId } : {}),
              ...(thread.id === threadId ? { self: true } : {}),
              ...(place.here ? {} : { machine: place.machine ?? "another machine" }),
            }))
          return JSON.stringify(listed)
        }),
      search_threads: ({ query, limit }) =>
        Effect.gen(function* () {
          const callerId = yield* McpTool.CallingThread
          const trimmed = query.trim()
          if (trimmed === "") return "[]"
          const max = limit ?? DEFAULT_SEARCH_LIMIT
          const [all, labels] = yield* Effect.all([threads.list, projectLabels])
          const searchable = all.filter((thread) => thread.status !== "draft")
          const titled = searchable
            .filter((thread) => thread.title.toLowerCase().includes(trimmed.toLowerCase()))
            .slice(0, max)
          const [newest, ofTitled] = yield* Effect.all([
            search.perThread(trimmed, { limit: max }),
            search.perThread(trimmed, { limit: titled.length, threadIds: titled.map((thread) => thread.id) }),
          ])
          const byId = new Map(searchable.map((thread) => [thread.id, thread]))
          const snippets = new Map([...ofTitled, ...newest].map((hit) => [hit.threadId, hit.snippet]))
          const ids = new Set([...titled.map((thread) => thread.id), ...newest.map((hit) => hit.threadId)])
          const found = [...ids].flatMap((id) => byId.get(id) ?? []).slice(0, max)
          return JSON.stringify(
            found.map((thread) => ({
              id: thread.id,
              title: thread.title,
              status: thread.status,
              project: labels.get(thread.projectId) ?? thread.projectId,
              ...(snippets.has(thread.id) ? { snippet: snippets.get(thread.id) } : {}),
              ...(thread.id === callerId ? { self: true } : {}),
            })),
          )
        }).pipe(Effect.mapError((error) => ({ message: error.message }))),
      read_thread: ({ threadId: targetId, limit }) =>
        Effect.gen(function* () {
          const { thread: target, place } = yield* locate(targetId, "anyProject")
          const { worktreeId } = target
          const [transcript, worktree, links] = place.here
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
          const pullRequestDetails = yield* Effect.forEach(links, (link) => describePullRequest(link.url), {
            concurrency: 4,
          })
          return [
            renderMetadata(target, pullRequestDetails),
            renderEnvironment(worktree, place),
            ...(waiting.length > 0 ? ["Waiting on the user for:", ...waiting] : []),
            "",
            messages.length === 0 ? "No messages yet." : messages.map(renderMessage).join("\n\n"),
          ].join("\n")
        }),
      send_to_thread: ({ threadId: targetId, prompt, model, effort }) =>
        Effect.gen(function* () {
          const {
            thread: target,
            place: { here },
          } = yield* peerThread(targetId)
          if (model !== undefined && model !== target.model && target.providerSessionId !== null) {
            return yield* Effect.fail({
              message: `Thread ${targetId} has started, so its model stays ${target.model}. Pass only \`effort\`.`,
            })
          }
          if (model !== undefined || effort !== undefined) {
            const patch = { id: targetId, model, effort }
            yield* here
              ? threads.update(patch).pipe(Effect.tap((thread) => events.publish({ type: "thread.updated", thread })))
              : peers.ask("threads.update", patch)
          }
          yield* here
            ? runner.steer(targetId, prompt, [])
            : peers.ask("threads.steer", { threadId: targetId, text: prompt })
          return isThreadBusy(target.status)
            ? `Steered the running turn of thread ${targetId}.`
            : `Started a new turn on thread ${targetId}.`
        }),
      stop_thread: ({ threadId: targetId }) =>
        Effect.gen(function* () {
          const {
            place: { here },
          } = yield* peerThread(targetId)
          yield* here ? runner.interrupt(targetId) : peers.ask("threads.interrupt", { threadId: targetId })
          return `Interrupted thread ${targetId}.`
        }),
    })
  }),
)
