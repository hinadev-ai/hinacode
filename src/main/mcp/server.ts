import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer as AiMcpServer, Tool } from "effect/ai"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { ProviderId } from "../../shared/agent.ts"
import { AgentRunner } from "../services/AgentRunner.ts"
import { Events } from "../services/Events.ts"
import { PullRequests } from "../services/PullRequests.ts"
import { Secrets } from "../services/Secrets.ts"
import { Threads } from "../services/Threads.ts"
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

const registerTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* AiMcpServer.McpServer
    const pullRequests = yield* PullRequests
    const secrets = yield* Secrets
    const credentials = yield* McpCredentials
    const runner = yield* AgentRunner
    const threads = yield* Threads
    const events = yield* Events

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
          "Start another thread in this project and send it a first prompt. It appears in the user's sidebar at once and runs on its own; this call returns its id without waiting for it. Defaults to this thread's provider and model. Pass `worktree` to run it in a new git worktree.",
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
        description: "List the pull requests linked to this thread.",
        parameters: NoParams,
        run: (_, threadId) =>
          Effect.map(pullRequests.list(threadId), (links) =>
            links.length === 0
              ? "No pull requests are linked to this thread."
              : links.map((link) => `- ${link.url}`).join("\n"),
          ),
      }),
      tool({
        name: "unlink_pull_request",
        description: "Remove a pull request link from this thread.",
        parameters: Schema.Struct({ url: PullRequestUrl }),
        run: ({ url }, threadId) => Effect.as(pullRequests.unlink(threadId, url), `Unlinked ${url}.`),
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
