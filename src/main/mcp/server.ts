import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer as AiMcpServer, Tool } from "effect/ai"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { ProviderId } from "../../shared/agent.ts"
import { isThreadBusy, type Message, type Thread, type Worktree } from "../../shared/domain.ts"
import { AgentRunner } from "../services/AgentRunner.ts"
import { Events } from "../services/Events.ts"
import { PullRequests } from "../services/PullRequests.ts"
import { Secrets } from "../services/Secrets.ts"
import { Threads } from "../services/Threads.ts"
import { Worktrees } from "../services/Worktrees.ts"
import type { VmAction } from "../services/tinyVm/rfb.ts"
import type { ExecResult } from "../services/tinyVm/sbx.ts"
import { TinyVm } from "../services/tinyVm/TinyVm.ts"
import { makeActiveWorkspace } from "../services/workspace.ts"
import { McpCredentials } from "./credentials.ts"
import { type Linear, makeLinear } from "./linear.ts"
import { reviewChanges } from "./reviewChanges.ts"

const MCP_PATH = "/mcp"
export const LINEAR_API_KEY_SECRET = "linear.apiKey"

interface ToolFailure {
  readonly message: string
}

type ToolOutput = string | ReadonlyArray<McpSchema.ContentBlock>

interface ToolSpec<S extends Schema.Top> {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly run: (input: S["Type"], threadId: string) => Effect.Effect<ToolOutput, ToolFailure>
  /** For example `McpSchema.EnabledWhen`, which hides the tool from both `tools/list` and `tools/call`. */
  readonly annotations?: Context.Context<never>
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

const toolResult = (output: ToolOutput) =>
  typeof output === "string" ? text(output) : new McpSchema.CallToolResult({ content: output, isError: false })

/** Waits this long after acting before the screenshot, so the screen has reacted. */
const SETTLE_MS = 500
const MAX_OUTPUT_CHARS = 20_000

const tail = (label: string, bytes: Uint8Array) => {
  const output = Buffer.from(bytes).toString()
  if (output === "") return `${label}: (empty)`
  if (output.length <= MAX_OUTPUT_CHARS) return `${label}:\n${output}`
  return `${label} (last ${MAX_OUTPUT_CHARS} of ${output.length} characters):\n${output.slice(-MAX_OUTPUT_CHARS)}`
}

const Coordinate = (axis: "x" | "y", what: string) =>
  Schema.Int.annotate({
    description: `${what}, in pixels of the latest screenshot from the ${axis === "x" ? "left" : "top"} edge.`,
  })

const execReport = (result: ExecResult, timeoutSeconds: number, background: boolean) => {
  if (background) {
    return result.exitCode === 0 && result.pid !== undefined
      ? `Started in the background as pid ${result.pid}. Output goes to ${result.log ?? "the sbx log"}.`
      : `Could not start it in the background (exit code ${result.exitCode}). ${result.error ?? ""}`.trim()
  }
  const status =
    result.exitCode === 124 ? `Timed out after ${timeoutSeconds} s (exit code 124).` : `Exit code ${result.exitCode}.`
  return [
    status,
    ...(result.error ? [result.error] : []),
    tail("stdout", result.stdout),
    tail("stderr", result.stderr),
  ].join("\n\n")
}

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
  [`## ${message.role} (${message.createdAt})`, ...message.parts.flatMap((part) => renderPart(part) ?? [])].join("\n")

const renderMetadata = (
  thread: Thread,
  worktree: Worktree | null,
  pullRequestUrls: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  `Agent: ${thread.provider}, model ${thread.model}.`,
  worktree === null
    ? "Workspace: the project root."
    : `Workspace: worktree on branch ${worktree.branch} at ${worktree.path}.`,
  `Created by ${thread.createdBy} at ${thread.createdAt}, last updated ${thread.updatedAt}.`,
  pullRequestUrls.length === 0
    ? "Pull requests: none."
    : ["Pull requests:", ...pullRequestUrls.map((url) => `- ${url}`)].join("\n"),
]

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
    const tinyVm = yield* TinyVm

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

    const vmAnnotations = Context.make(McpSchema.EnabledWhen, () => tinyVm.enabled())
    const screenImage = (threadId: string) =>
      Effect.map(tinyVm.screenshot(threadId), (data): McpSchema.ContentBlock => ({
        type: "image",
        data,
        mimeType: "image/png",
      }))
    const HANDED_BACK =
      "The user had control and has handed it back. The screen may have changed, so this action was not performed. Look at the screenshot before you continue."
    /** Performs one pointer or keyboard action, then shows the agent the screen it left. */
    const actAndLook = (threadId: string, action: VmAction, done: string) =>
      Effect.gen(function* () {
        const outcome = yield* tinyVm.act(threadId, [action])
        if (outcome === "done") yield* Effect.sleep(SETTLE_MS)
        const image = yield* screenImage(threadId)
        return [{ type: "text", text: outcome === "done" ? done : HANDED_BACK }, image] as const
      }).pipe(Effect.mapError(failure))

    const STARTS = "Starts the thread's tiny VM on first use."
    const WAITS =
      "While the user has control it waits for them to hand it back and then returns the screen without acting."
    const SHOWS = "Returns a screenshot taken just after acting."

    const vmTool = <S extends Schema.Top>(spec: Omit<ToolSpec<S>, "annotations">) =>
      tool({ ...spec, annotations: vmAnnotations })

    const vmTools = [
      vmTool({
        name: "vm_screenshot",
        description: `Take a screenshot of the tiny VM's 1280×800 desktop. ${STARTS}`,
        parameters: NoParams,
        run: (_, threadId) =>
          Effect.map(
            screenImage(threadId),
            (image) => [{ type: "text", text: "Screen 1280×800." }, image] as const,
          ).pipe(Effect.mapError(failure)),
      }),
      vmTool({
        name: "vm_click",
        description: `Click in the tiny VM at a point of the latest screenshot. ${STARTS} ${WAITS} ${SHOWS}`,
        parameters: Schema.Struct({
          x: Coordinate("x", "Horizontal position"),
          y: Coordinate("y", "Vertical position"),
          button: Schema.optionalKey(
            Schema.Literals(["left", "right", "middle"]).annotate({ description: "Defaults to left." }),
          ),
          clicks: Schema.optionalKey(
            Schema.Literals([1, 2, 3]).annotate({ description: "1, 2 for a double click or 3. Defaults to 1." }),
          ),
        }),
        run: ({ x, y, button = "left", clicks = 1 }, threadId) =>
          actAndLook(
            threadId,
            { type: "click", x, y, button, clicks },
            `${clicks === 1 ? "Clicked" : `Clicked ${clicks} times`} ${button} at ${x}, ${y}.`,
          ),
      }),
      vmTool({
        name: "vm_move",
        description: `Move the tiny VM's pointer to a point of the latest screenshot, for example to hover. ${STARTS} ${WAITS} ${SHOWS}`,
        parameters: Schema.Struct({
          x: Coordinate("x", "Horizontal position"),
          y: Coordinate("y", "Vertical position"),
        }),
        run: ({ x, y }, threadId) => actAndLook(threadId, { type: "move", x, y }, `Moved the pointer to ${x}, ${y}.`),
      }),
      vmTool({
        name: "vm_drag",
        description: `Drag with the left button held from one point of the latest screenshot to another. ${STARTS} ${WAITS} ${SHOWS}`,
        parameters: Schema.Struct({
          x: Coordinate("x", "Start position"),
          y: Coordinate("y", "Start position"),
          toX: Coordinate("x", "End position"),
          toY: Coordinate("y", "End position"),
        }),
        run: ({ x, y, toX, toY }, threadId) =>
          actAndLook(threadId, { type: "drag", x, y, toX, toY }, `Dragged from ${x}, ${y} to ${toX}, ${toY}.`),
      }),
      vmTool({
        name: "vm_scroll",
        description: `Scroll the mouse wheel in the tiny VM with the pointer at a point of the latest screenshot. ${STARTS} ${WAITS} ${SHOWS}`,
        parameters: Schema.Struct({
          x: Coordinate("x", "Pointer position"),
          y: Coordinate("y", "Pointer position"),
          direction: Schema.Literals(["up", "down", "left", "right"]),
          amount: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
              description: "Wheel notches, 1-20. Defaults to 3.",
            }),
          ),
        }),
        run: ({ x, y, direction, amount = 3 }, threadId) =>
          actAndLook(
            threadId,
            { type: "scroll", x, y, direction, amount },
            `Scrolled ${direction} ${amount} ${amount === 1 ? "notch" : "notches"} at ${x}, ${y}.`,
          ),
      }),
      vmTool({
        name: "vm_type",
        description: `Type text into the tiny VM's focused window, as key presses. Any Unicode text works; "\\n" presses Return and "\\t" Tab. Click the field first. ${STARTS} ${WAITS} ${SHOWS}`,
        parameters: Schema.Struct({
          text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({ description: "At most 10,000 characters." }),
        }),
        run: ({ text: typed }, threadId) =>
          actAndLook(threadId, { type: "type", text: typed }, `Typed ${[...typed].length} characters.`),
      }),
      vmTool({
        name: "vm_key",
        description: `Press keys or shortcuts in the tiny VM, xdotool style: Return, Escape, BackSpace, Tab, Page_Down, F5, ctrl+l, ctrl+shift+t, alt+F4. Separate several with spaces to press them in order. ${STARTS} ${WAITS} ${SHOWS}`,
        parameters: Schema.Struct({
          keys: Schema.String.annotate({ description: "For example `ctrl+a BackSpace` or `Return`." }),
        }),
        run: ({ keys }, threadId) => actAndLook(threadId, { type: "key", keys }, `Pressed ${keys}.`),
      }),
      vmTool({
        name: "vm_exec",
        description: `Run a bash script in the tiny VM as \`user\` (passwordless sudo, DISPLAY=:0) and return its exit code, stdout and stderr. Start GUI programs and servers with \`background: true\`. ${STARTS}`,
        parameters: Schema.Struct({
          command: Schema.String.annotate({ description: "Run with bash -lc." }),
          timeoutSeconds: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })).annotate({
              description: "1-600. Defaults to 120.",
            }),
          ),
          background: Schema.optionalKey(
            Schema.Boolean.annotate({ description: "Return at once with the pid and log path instead of waiting." }),
          ),
        }),
        run: ({ command, timeoutSeconds = 120, background = false }, threadId) =>
          tinyVm.exec(threadId, { command, timeoutSeconds, background }).pipe(
            Effect.map((output) => execReport(output, timeoutSeconds, background)),
            Effect.mapError(failure),
          ),
      }),
    ]

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
          "Read another thread of this project: its status, agent and model, workspace, linked pull requests, whether it is waiting on the user, and its latest messages.",
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
            const worktree =
              target.worktreeId === null
                ? null
                : yield* worktrees.get(target.worktreeId).pipe(
                    Effect.catchTag("NotFoundError", () => Effect.succeed(null)),
                    Effect.mapError(failure),
                  )
            const links = yield* pullRequests.list(targetId).pipe(Effect.mapError(failure))
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
              ...renderMetadata(
                target,
                worktree,
                links.map((link) => link.url),
              ),
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
      ...vmTools,
    ]

    yield* Effect.forEach(tools, (spec) =>
      server.addTool({
        tool: new McpSchema.Tool({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema }),
        annotations: spec.annotations ?? Context.empty(),
        handle: (payload) =>
          Effect.gen(function* () {
            const threadId = yield* callingThreadId(credentials)
            if (Option.isNone(threadId)) return text("The MCP credential is not valid for any thread.", true)
            return yield* spec.run(payload ?? {}, threadId.value).pipe(
              Effect.match({
                onFailure: (error) => text(error.message, true),
                onSuccess: toolResult,
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
