import { Context, Effect, Option, Schema, Stream } from "effect"
import { AiError, McpSchema, McpServer, Tool, type Toolkit } from "effect/ai"
import { HttpServerRequest } from "effect/http"
import { McpCredentials } from "../credentials.ts"

export class CallingThread extends Context.Service<CallingThread, string>()("hinacode/mcp/CallingThread") {}

const Output = Schema.Union([Schema.String, Schema.Array(McpSchema.ContentBlock)])

const Failure = Schema.Struct({ message: Schema.String })

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

type HinacodeTool = ReturnType<typeof make<string, Schema.Top>>

const text = (value: string, isError = false) =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text: value }], isError })

const toolResult = (output: typeof Output.Type) =>
  typeof output === "string" ? text(output) : new McpSchema.CallToolResult({ content: output, isError: false })

const errorMessage = (error: { readonly message: string }) =>
  AiError.isAiError(error) && error.reason._tag === "ToolParameterValidationError"
    ? error.reason.description
    : error.message

// FIXME: McpServer runs handlers in the request fiber without declaring it in their type
const callingThreadId = (credentials: typeof McpCredentials.Service) =>
  Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
    Option.flatMap(request, (current) => credentials.authenticate(current.headers["authorization"])),
  )

// FIXME: `McpServer.toolkit` JSON-encodes every result, which quotes text and cannot return images
export const register = Effect.fnUntraced(function* <Tools extends Record<string, HinacodeTool>>(
  toolkit: Toolkit.Toolkit<Tools>,
  annotations: Context.Context<never> = Context.empty(),
) {
  const server = yield* McpServer.McpServer
  const credentials = yield* McpCredentials
  const built = yield* toolkit
  // FIXME: `Tool.HandlerServices` and `Tool.Result` do not reduce for a generic `Tools`
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
              Effect.as(text(`${tool.name} failed unexpectedly. See the HinaCode logs.`, true)),
            ),
          ),
        ),
    }),
  )
})
