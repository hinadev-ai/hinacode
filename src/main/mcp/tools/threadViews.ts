import { Effect, Schema } from "effect"
import type { RpcResponse } from "../../../shared/contract.ts"
import type { Machine, Message, Thread, Worktree } from "../../../shared/domain.ts"
import type { Projects } from "../../services/Projects.ts"
import type { Search } from "../../services/Search.ts"

export const DEFAULT_READ_LIMIT = 20
export const MAX_READ_LIMIT = 100
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 100

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
    case "signed_out":
      return part.loginCommand === undefined
        ? `**Error:** ${part.message}. Sign in as the model provider's documentation describes.`
        : `**Error:** ${part.message}. Sign in with \`${part.loginCommand}\``
    case "session_import":
      return part.history === "replayed"
        ? `[imported ${part.provider} session]`
        : `[imported ${part.provider} session, earlier history not shown]`
  }
}

const renderMessage = (message: Message) =>
  [`## ${message.role} (${message.createdAt})`, ...message.parts.flatMap((part) => renderPart(part) ?? [])].join("\n")

export const renderMetadata = (thread: Thread, pullRequestUrls: ReadonlyArray<string>) =>
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
    ...(pullRequestUrls.length === 0
      ? ["pull_requests: none"]
      : ["pull_requests:", ...pullRequestUrls.map((url) => `- ${url}`)]),
    "</metadata>",
  ].join("\n")

export type Place =
  | { readonly here: true; readonly project?: string }
  | { readonly here: false; readonly machine: MachineRef | undefined }
type MachineRef = Pick<Machine, "id" | "name">
export const HERE: Place = { here: true }

export const renderEnvironment = (worktree: Worktree | null, place: Place) =>
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

export const Effort = Schema.String.annotate({ description: "Reasoning effort, such as low, medium or high." })

export const NewWorktree = Schema.Struct({
  branch: Schema.String.annotate({ description: "Branch to create for the worktree." }),
  baseRef: Schema.String.annotate({ description: "Ref the branch forks from, for example main." }),
})

export const ReadLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_READ_LIMIT })).annotate({
  description: `Latest messages to return, 1-${MAX_READ_LIMIT}. Defaults to ${DEFAULT_READ_LIMIT}.`,
})

export const SearchLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT })).annotate({
  description: `Threads to return, 1-${MAX_SEARCH_LIMIT}. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
})

export const projectLabels = (projects: typeof Projects.Service) =>
  Effect.map(
    projects.list,
    (all) => new Map(all.map((project) => [project.id, `${project.name} (${project.rootPath})`])),
  )

export const listedThread = (thread: Thread, branch: string | null | undefined) => ({
  id: thread.id,
  title: thread.title,
  status: thread.status,
  provider: thread.provider,
  model: thread.model,
  createdBy: thread.createdBy,
  branch: branch ?? null,
})

export const renderThread = (input: {
  readonly thread: Thread
  readonly place: Place
  readonly transcript: RpcResponse<"threads.transcript">
  readonly worktree: Worktree | null
  readonly pullRequestUrls: ReadonlyArray<string>
  readonly limit: number | undefined
}) => {
  const { transcript } = input
  const waiting = [
    ...transcript.approvals.map((request) => `- approval: ${request.title}`),
    ...transcript.questions.flatMap((request) =>
      request.questions.map((question) => `- question: ${question.question}`),
    ),
    ...transcript.secretRequests.map((request) => `- secret: ${request.name}`),
  ]
  const messages = transcript.messages.slice(-(input.limit ?? DEFAULT_READ_LIMIT))
  return [
    renderMetadata(input.thread, input.pullRequestUrls),
    renderEnvironment(input.worktree, input.place),
    ...(waiting.length > 0 ? ["Waiting on the user for:", ...waiting] : []),
    "",
    messages.length === 0 ? "No messages yet." : messages.map(renderMessage).join("\n\n"),
  ].join("\n")
}

export const searchThreads = (
  services: {
    readonly threads: ReadonlyArray<Thread>
    readonly labels: ReadonlyMap<string, string>
    readonly search: typeof Search.Service
  },
  query: string,
  options: { readonly limit: number | undefined; readonly self?: string },
) =>
  Effect.gen(function* () {
    const trimmed = query.trim()
    if (trimmed === "") return "[]"
    const max = options.limit ?? DEFAULT_SEARCH_LIMIT
    const searchable = services.threads.filter((thread) => thread.status !== "draft")
    const titled = searchable
      .filter((thread) => thread.title.toLowerCase().includes(trimmed.toLowerCase()))
      .slice(0, max)
    const [newest, ofTitled] = yield* Effect.all([
      services.search.perThread(trimmed, { limit: max }),
      services.search.perThread(trimmed, { limit: titled.length, threadIds: titled.map((thread) => thread.id) }),
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
        project: services.labels.get(thread.projectId) ?? thread.projectId,
        ...(snippets.has(thread.id) ? { snippet: snippets.get(thread.id) } : {}),
        ...(thread.id === options.self ? { self: true } : {}),
      })),
    )
  })
