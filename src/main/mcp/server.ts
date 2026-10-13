import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer as AiMcpServer, Tool } from "effect/ai"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { ProviderId } from "../../shared/agent.ts"
import { isThreadBusy, type Message, type Thread, WatchEventKind } from "../../shared/domain.ts"
import { AgentRunner } from "../services/AgentRunner.ts"
import { Events } from "../services/Events.ts"
import { PullRequests } from "../services/PullRequests.ts"
import { Secrets } from "../services/Secrets.ts"
import { Threads } from "../services/Threads.ts"
import { Worktrees } from "../services/Worktrees.ts"
import { makeActiveWorkspace } from "../services/workspace.ts"
import { McpCredentials } from "./credentials.ts"
import { type Linear, makeLinear } from "./linear.ts"
import { reviewChanges } from "./reviewChanges.ts"

const MCP_PATH = "/mcp"
export const LINEAR_API_KEY_SECRET = "linear.apiKey"

interface ToolFailure {
  readonly message: string
}

interface ToolSpec<S extends Schema.Top> {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly run: (input: S["Type"], threadId: string) => Effect.Effect<string, ToolFailure>
}

/** Erases the parameter type so tools with different inputs fit in one list. */
const tool = <S extends Schema.Top>({ parameters, run, ...rest }: ToolSpec<S>) => {
  const decode = Schema.decodeUnknownEffect(parameters)
  return {
    ...rest,
    inputSchema: Schema.decodeUnknownSync(McpSchema.ToolJson)(Tool.getJsonSchemaFromSchema(parameters)),
    run: (payload: unknown, threadId: string) =>
      decode(payload).pipe(
        Effect.mapError((error): ToolFailure => ({ message: error.message })),
        Effect.flatMap((input) => run(input, threadId)),
      ),
  }
}

const NoParams = Tool.EmptyParams

const text = (value: string, isError = false) =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text: value }], isError })

/**
 * McpServer runs tool handlers inside the HTTP request fiber but does not declare that in their type,
 * hence `serviceOption`.
 */
const callingThreadId = (credentials: typeof McpCredentials.Service) =>
  Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
    Option.flatMap(request, (current) => credentials.authenticate(current.headers["authorization"])),
  )

const failure = (error: { readonly message: string }): ToolFailure => ({ message: error.message })

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
  }
}

const renderMessage = (message: Message) =>
  [`## ${message.role}`, ...message.parts.flatMap((part) => renderPart(part) ?? [])].join("\n")

const registerTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* AiMcpServer.McpServer
    const pullRequests = yield* PullRequests
    const secrets = yield* Secrets
    const credentials = yield* McpCredentials
    const runner = yield* AgentRunner
    const threads = yield* Threads
    const events = yield* Events
    const worktrees = yield* Worktrees

    const activeWorkspace = yield* makeActiveWorkspace

    const withLinear = <A>(use: (linear: Linear) => Effect.Effect<A, ToolFailure>) =>
      Effect.flatMap(
        secrets.get(LINEAR_API_KEY_SECRET),
        Option.match({
          onNone: () =>
            Effect.fail({
              message:
                "No Linear API key is configured. Ask the user to add one in kkcode Settings > Integrations, then retry.",
            }),
          onSome: (apiKey) => Effect.flatMap(makeLinear(apiKey), use),
        }),
      )

    const IssueKey = Schema.String.annotate({ description: "Linear issue identifier, for example ENG-123" })
    const PullRequestUrl = Schema.String.annotate({
      description: "GitHub pull request URL, for example https://github.com/owner/repo/pull/123",
    })

    const SecretName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).annotate({
      description:
        "Name the value is stored under, for example stripe.apiKey. Letters, digits, dots, dashes and underscores.",
    })

    /** A thread of the caller's project, so an agent cannot reach into another project's threads. */
    const projectThread = (callerId: string, targetId: string) =>
      Effect.gen(function* () {
        const caller = yield* threads.get(callerId)
        const target = yield* threads
          .get(targetId)
          .pipe(
            Effect.catchTag("NotFoundError", () => Effect.fail({ message: `Thread ${targetId} no longer exists.` })),
          )
        if (target.projectId !== caller.projectId) {
          return yield* Effect.fail({ message: `Thread ${targetId} is not in this project.` })
        }
        return target
      }).pipe(Effect.mapError(failure))

    const peerThread = (callerId: string, targetId: string): Effect.Effect<Thread, ToolFailure> =>
      targetId === callerId
        ? Effect.fail({ message: "That is this thread. Use your own turn instead." })
        : projectThread(callerId, targetId)

    const TargetThreadId = Schema.String.annotate({ description: "Id of a thread in this project." })

    const tools = [
      tool({
        name: "request_secret",
        description:
          "Ask the user for a secret (API key, token, password). kkcode shows them a masked input in this thread and stores what they enter under `name`. The value is never returned to you: tell the user where the stored secret is needed instead of asking them to paste it into the chat. Blocks until they answer or the turn ends.",
        parameters: Schema.Struct({
          name: SecretName,
          description: Schema.String.annotate({ description: "What the secret is for, shown to the user." }),
        }),
        run: ({ name, description }, threadId) =>
          runner.requestSecret(threadId, name, description).pipe(
            Effect.mapError(failure),
            Effect.flatMap((outcome) =>
              outcome === "stored"
                ? Effect.succeed(
                    `Stored secret "${name}". The value is never returned to you; tell the user which setting or environment variable needs it.`,
                  )
                : Effect.fail({ message: `The user declined to provide secret "${name}".` }),
            ),
          ),
      }),
      tool({
        name: "create_thread",
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
        run: ({ title, prompt, provider, model, worktree }, threadId) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.mapError(failure)),
      }),
      tool({
        name: "list_threads",
        description:
          "List the threads in this project that are not archived: id, title, status, provider, model, who created it, and its worktree branch. `self` marks this thread.",
        parameters: NoParams,
        run: (_, threadId) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.mapError(failure)),
      }),
      tool({
        name: "read_thread",
        description:
          "Read another thread of this project: its status, whether it is waiting on the user, and its latest messages.",
        parameters: Schema.Struct({
          threadId: TargetThreadId,
          limit: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_READ_LIMIT })).annotate({
              description: `Latest messages to return, 1-${MAX_READ_LIMIT}. Defaults to ${DEFAULT_READ_LIMIT}.`,
            }),
          ),
        }),
        run: ({ threadId: targetId, limit }, threadId) =>
          Effect.gen(function* () {
            const target = yield* projectThread(threadId, targetId)
            const transcript = yield* runner.transcript(targetId).pipe(Effect.mapError(failure))
            const waiting = [
              ...transcript.approvals.map((request) => `- approval: ${request.title}`),
              ...transcript.questions.flatMap((request) =>
                request.questions.map((question) => `- question: ${question.question}`),
              ),
              ...transcript.secretRequests.map((request) => `- secret: ${request.name}`),
            ]
            const messages = transcript.messages.slice(-(limit ?? DEFAULT_READ_LIMIT))
            return [
              `Thread ${target.id} "${target.title}" is ${target.status}.`,
              ...(waiting.length > 0 ? ["Waiting on the user for:", ...waiting] : []),
              "",
              messages.length === 0 ? "No messages yet." : messages.map(renderMessage).join("\n\n"),
            ].join("\n")
          }),
      }),
      tool({
        name: "send_to_thread",
        description:
          "Send a message to another thread of this project. A running thread gets it as steering input in its current turn; an idle one starts a new turn with it.",
        parameters: Schema.Struct({
          threadId: TargetThreadId,
          prompt: Schema.String.annotate({ description: "The user message to send." }),
        }),
        run: ({ threadId: targetId, prompt }, threadId) =>
          Effect.gen(function* () {
            const target = yield* peerThread(threadId, targetId)
            if (isThreadBusy(target.status)) {
              yield* runner.steer(targetId, prompt, []).pipe(Effect.mapError(failure))
              return `Steered the running turn of thread ${targetId}.`
            }
            yield* runner.send(targetId, prompt, []).pipe(Effect.mapError(failure))
            return `Started a new turn on thread ${targetId}.`
          }),
      }),
      tool({
        name: "stop_thread",
        description: "Interrupt the running turn of another thread in this project. Does nothing if it is idle.",
        parameters: Schema.Struct({ threadId: TargetThreadId }),
        run: ({ threadId: targetId }, threadId) =>
          peerThread(threadId, targetId).pipe(
            Effect.andThen(runner.interrupt(targetId)),
            Effect.as(`Interrupted thread ${targetId}.`),
          ),
      }),
      tool({
        name: "review_changes",
        description:
          "Review this thread's uncommitted and branch changes: git status plus the unified diff against HEAD and, in a worktree, against the merge-base with its base branch.",
        parameters: NoParams,
        run: (_, threadId) =>
          activeWorkspace(threadId).pipe(
            Effect.catchTag("NotFoundError", () => Effect.fail({ message: `Thread ${threadId} no longer exists.` })),
            Effect.flatMap(reviewChanges),
          ),
      }),
      tool({
        name: "link_pull_request",
        description:
          "Register a GitHub pull request you opened for this thread so the user sees it next to the thread. Call it right after creating the PR.",
        parameters: Schema.Struct({ url: PullRequestUrl }),
        run: ({ url }, threadId) =>
          Effect.map(pullRequests.link(threadId, url), (canonical) => `Linked ${canonical} to this thread.`),
      }),
      tool({
        name: "list_thread_pull_requests",
        description: "List the pull requests linked to this thread, marking the ones this thread is watching.",
        parameters: NoParams,
        run: (_, threadId) =>
          Effect.map(pullRequests.list(threadId), (links) =>
            links.length === 0
              ? "No pull requests are linked to this thread."
              : links
                  .map((link) =>
                    link.watch === null
                      ? `- ${link.url}`
                      : `- ${link.url} (watching for ${link.watch.events.join(", ")}; ${link.watch.wakes} ${link.watch.wakes === 1 ? "wake" : "wakes"})`,
                  )
                  .join("\n"),
          ),
      }),
      tool({
        name: "unlink_pull_request",
        description: "Remove a pull request link from this thread. A watch on it ends with the link.",
        parameters: Schema.Struct({ url: PullRequestUrl }),
        run: ({ url }, threadId) => Effect.as(pullRequests.unlink(threadId, url), `Unlinked ${url}.`),
      }),
      tool({
        name: "watch_pull_request",
        description:
          "Watch a pull request for this thread instead of polling it yourself. kkcode checks it every minute and sends this thread a new message when something you care about changes, so end your turn after calling this. The watch ends on its own when the pull request merges or closes. Links the pull request first when it is not linked yet.",
        parameters: Schema.Struct({
          url: PullRequestUrl,
          events: Schema.optionalKey(
            Schema.Array(WatchEventKind).annotate({
              description:
                "What to be woken for. Defaults to all of checksFailed, checksPassed, reviewChanged, conflicting and mergedOrClosed.",
            }),
          ),
        }),
        run: ({ url, events: kinds }, threadId) =>
          Effect.map(
            pullRequests.watch(threadId, url, kinds ?? []),
            (link) =>
              `Watching ${link.url} for ${link.watch?.events.join(", ") ?? ""}. kkcode checks it every minute and will send this thread a message when one of those changes. Do not poll for it.`,
          ),
      }),
      tool({
        name: "unwatch_pull_request",
        description: "Stop watching a pull request for this thread. The link itself stays.",
        parameters: Schema.Struct({ url: PullRequestUrl }),
        run: ({ url }, threadId) => Effect.as(pullRequests.unwatch(threadId, url), `Stopped watching ${url}.`),
      }),
      tool({
        name: "linear_get_issue",
        description: "Read a Linear issue: title, state, assignee, priority, URL and description.",
        parameters: Schema.Struct({ key: IssueKey }),
        run: ({ key }) => withLinear((linear) => linear.getIssue(key)),
      }),
      tool({
        name: "linear_search_issues",
        description: "Full-text search Linear issues. Returns identifier, title and URL per match.",
        parameters: Schema.Struct({
          query: Schema.String,
          limit: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
              description: "Maximum results, 1-50. Defaults to 10.",
            }),
          ),
        }),
        run: ({ query, limit }) => withLinear((linear) => linear.searchIssues(query, limit ?? 10)),
      }),
      tool({
        name: "linear_create_comment",
        description: "Post a markdown comment on a Linear issue.",
        parameters: Schema.Struct({ key: IssueKey, body: Schema.String.annotate({ description: "Markdown body" }) }),
        run: ({ key, body }) => withLinear((linear) => linear.createComment(key, body)),
      }),
      tool({
        name: "linear_update_issue_state",
        description: "Move a Linear issue to a workflow state of its team, matched by name (case-insensitive).",
        parameters: Schema.Struct({
          key: IssueKey,
          stateName: Schema.String.annotate({ description: "Workflow state name, for example In Review" }),
        }),
        run: ({ key, stateName }) => withLinear((linear) => linear.updateIssueState(key, stateName)),
      }),
    ]

    const annotations = Context.empty()
    yield* Effect.forEach(tools, (spec) =>
      server.addTool({
        tool: new McpSchema.Tool({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema }),
        annotations,
        handle: (payload) =>
          Effect.gen(function* () {
            const threadId = yield* callingThreadId(credentials)
            if (Option.isNone(threadId)) return text("The MCP credential is not valid for any thread.", true)
            return yield* spec.run(payload ?? {}, threadId.value).pipe(
              Effect.match({
                onFailure: (error) => text(error.message, true),
                onSuccess: (report) => text(report),
              }),
            )
          }).pipe(
            Effect.catchDefect((defect) =>
              Effect.logError("mcp tool defect", spec.name, defect).pipe(
                Effect.as(text(`${spec.name} failed unexpectedly. See the kkcode logs.`, true)),
              ),
            ),
          ),
      }),
    )
  }),
)

/** Rejects requests without a credential for an existing thread, so other local processes cannot act as a thread. */
const requireCredential = HttpRouter.middleware(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const credentials = yield* McpCredentials
    const threadExists = (threadId: string) =>
      sql`SELECT 1 FROM thread WHERE id = ${threadId}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orElseSucceed(() => false),
      )
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const threadId = credentials.authenticate(request.headers["authorization"])
        if (Option.isNone(threadId) || !(yield* threadExists(threadId.value))) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 401 })
        }
        return yield* httpEffect
      })
  }),
  { global: true },
)

const httpServer = HttpRouter.serve(
  Layer.mergeAll(registerTools, requireCredential).pipe(
    Layer.provideMerge(
      AiMcpServer.layerHttp({
        name: "kkcode",
        version: "0.1.0",
        path: MCP_PATH,
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
        allowSessionTermination: true,
      }),
    ),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })))

/** Tells the credential store where the server listens, so turns can be handed a connection. */
const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    if (address._tag === "UnixPathAddress") return yield* Effect.die("MCP server must listen on TCP")
    const url = `http://127.0.0.1:${address.port}${MCP_PATH}`
    yield* Effect.logInfo("mcp server listening", url)
    yield* (yield* McpCredentials).listening(url)
  }),
)

/**
 * The built-in MCP server agents call back into. One HTTP listener on 127.0.0.1 for the whole app;
 * each thread gets its own bearer credential from `McpCredentials`, and the credential alone decides
 * which thread a call acts as.
 */
export const layer = announce.pipe(Layer.provide(httpServer))
