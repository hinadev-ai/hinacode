import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer as AiMcpServer, Tool } from "effect/ai"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import type { McpConnection } from "../../shared/agent.ts"
import { PullRequests } from "../services/PullRequests.ts"
import { Secrets } from "../services/Secrets.ts"
import { makeActiveWorkspace } from "../services/workspace.ts"
import { type Linear, makeLinear } from "./linear.ts"
import { reviewChanges } from "./reviewChanges.ts"

const MCP_PATH = "/mcp"
export const LINEAR_API_KEY_SECRET = "linear.apiKey"

/**
 * The built-in MCP server agents call back into. One HTTP listener on 127.0.0.1 for the whole app;
 * each thread gets its own bearer credential, and the credential alone decides which thread a call acts as.
 */
export class McpServer extends Context.Service<
  McpServer,
  {
    /** Issues the thread's credential on first use; it stays valid while the thread exists. */
    readonly connectionFor: (threadId: string) => McpConnection
  }
>()("kkcode/McpServer") {}

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

/** Thread id to its secret. A credential is `<threadId>.<secret>`. */
type CredentialStore = Map<string, Buffer>

class Credentials extends Context.Service<Credentials, CredentialStore>()("kkcode/McpServer/Credentials") {}

const BEARER = "Bearer "

/** The thread the request's credential was issued for; the comparison is constant-time per thread. */
const authenticate = (credentials: CredentialStore, request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers["authorization"]
  if (authorization === undefined || !authorization.startsWith(BEARER)) return Option.none()
  const credential = authorization.slice(BEARER.length)
  const separator = credential.lastIndexOf(".")
  if (separator <= 0) return Option.none()
  const threadId = credential.slice(0, separator)
  const expected = credentials.get(threadId)
  const presented = Buffer.from(credential.slice(separator + 1))
  const valid = expected !== undefined && presented.length === expected.length && timingSafeEqual(presented, expected)
  return valid ? Option.some(threadId) : Option.none()
}

/**
 * McpServer runs tool handlers inside the HTTP request fiber but does not declare that in their type,
 * hence `serviceOption`.
 */
const callingThreadId = (credentials: CredentialStore) =>
  Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
    Option.flatMap(request, (current) => authenticate(credentials, current)),
  )

const registerTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* AiMcpServer.McpServer
    const pullRequests = yield* PullRequests
    const secrets = yield* Secrets
    const credentials = yield* Credentials

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

    const tools = [
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
const requireCredential = (credentials: CredentialStore) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const threadExists = (threadId: string) =>
        sql`SELECT 1 FROM thread WHERE id = ${threadId}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orElseSucceed(() => false),
        )
      return (httpEffect) =>
        Effect.gen(function* () {
          const threadId = authenticate(credentials, yield* HttpServerRequest.HttpServerRequest)
          if (Option.isNone(threadId) || !(yield* threadExists(threadId.value))) {
            return HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 401 })
          }
          return yield* httpEffect
        })
    }),
    { global: true },
  )

const httpServer = (credentials: CredentialStore) =>
  HttpRouter.serve(
    Layer.mergeAll(registerTools, requireCredential(credentials)).pipe(
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
  ).pipe(
    Layer.provide(Layer.succeed(Credentials, credentials)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
  )

const make = (credentials: CredentialStore) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    if (address._tag === "UnixPathAddress") return yield* Effect.die("MCP server must listen on TCP")
    const url = `http://127.0.0.1:${address.port}${MCP_PATH}`
    yield* Effect.logInfo("mcp server listening", url)
    return McpServer.of({
      connectionFor: (threadId) => {
        let secret = credentials.get(threadId)
        if (secret === undefined) {
          secret = Buffer.from(randomBytes(32).toString("base64url"))
          credentials.set(threadId, secret)
        }
        return { url, headers: { authorization: `${BEARER}${threadId}.${secret.toString()}` } }
      },
    })
  })

export const layer = Layer.unwrap(
  Effect.sync(() => {
    const credentials: CredentialStore = new Map()
    return Layer.effect(McpServer, make(credentials)).pipe(Layer.provide(httpServer(credentials)))
  }),
)
