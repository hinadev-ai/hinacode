import { Context, Effect, Option, Schema, Stream } from "effect"
import { AiError, McpSchema, McpServer, Tool, type Toolkit } from "effect/ai"
import { HttpServerRequest } from "effect/http"
import { McpCredentials } from "../credentials.ts"

/** The thread whose credential made the current call. Every tool acts as this thread. */
export class CallingThread extends Context.Service<CallingThread, string>()("kkcode/mcp/CallingThread") {}

/** Plain text, or content blocks such as a screenshot. */
const Output = Schema.Union([Schema.String, Schema.Array(McpSchema.ContentBlock)])

/** Any error with a message: the agent reads it as the tool's error result. */
const Failure = Schema.Struct({ message: Schema.String })

/** A kkcode tool: its handler may read `CallingThread` and returns `Output`. */
export const make = <const Name extends string, Parameters extends Schema.Constraint = Tool.EmptyParams>(
  name: Name,
  options: { readonly description: string; readonly parameters?: Parameters },
) =>
  Tool.make(name, {
    description: options.description,
    parameters: options.parameters,
    success: Output,
    failure: Failure,
    dependencies: [CallingThread],
  })

type KkcodeTool = ReturnType<typeof make<string, Schema.Top>>

const text = (value: string, isError = false) =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text: value }], isError })

const toolResult = (output: typeof Output.Type) =>
  typeof output === "string" ? text(output) : new McpSchema.CallToolResult({ content: output, isError: false })

const errorMessage = (error: { readonly message: string }) =>
  AiError.isAiError(error) && error.reason._tag === "ToolParameterValidationError"
    ? error.reason.description
    : error.message

/**
 * McpServer runs tool handlers inside the HTTP request fiber but does not declare that in their type,
 * hence `serviceOption`.
 */
const callingThreadId = (credentials: typeof McpCredentials.Service) =>
  Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
    Option.flatMap(request, (current) => credentials.authenticate(current.headers["authorization"])),
  )

/**
 * Adds a toolkit's tools to the MCP server. `McpServer.toolkit` would JSON-encode every result,
 * which quotes plain text and cannot return images, so this renders `Output` as content instead.
 *
 * `annotations` apply to every tool of the toolkit, for example `McpSchema.EnabledWhen`, which hides
 * them from both `tools/list` and `tools/call`.
 */
export const register = Effect.fnUntraced(function* <Tools extends Record<string, KkcodeTool>>(
  toolkit: Toolkit.Toolkit<Tools>,
  annotations: Context.Context<never> = Context.empty(),
) {
  const server = yield* McpServer.McpServer
  const credentials = yield* McpCredentials
  const built = yield* toolkit
  // `Tool.HandlerServices` and `Tool.Result` do not reduce for a generic `Tools`. `make` fixes them for every tool.
  const handle = built.handle as unknown as (
    name: string,
    payload: unknown,
  ) => Effect.Effect<
    Stream.Stream<{ readonly result: typeof Output.Type }, { readonly message: string }, CallingThread>,
    { readonly message: string },
    CallingThread
  >
  yield* Effect.forEach(Object.values(built.tools), (tool) =>
    server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: tool.description,
        inputSchema: Schema.decodeUnknownSync(McpSchema.ToolJson)(Tool.getJsonSchema(tool)),
      }),
      annotations,
      handle: (payload) =>
        Effect.gen(function* () {
          const threadId = yield* callingThreadId(credentials)
          if (Option.isNone(threadId)) return text("The MCP credential is not valid for any thread.", true)
          return yield* handle(tool.name, payload ?? {}).pipe(
            Stream.unwrap,
            Stream.runLast,
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(CallingThread, threadId.value),
            Effect.match({
              onFailure: (error) => text(errorMessage(error), true),
              onSuccess: ({ result }) => toolResult(result),
            }),
          )
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logError("mcp tool defect", tool.name, defect).pipe(
              Effect.as(text(`${tool.name} failed unexpectedly. See the kkcode logs.`, true)),
            ),
          ),
        ),
    }),
  )
})
