import { Context, Effect, Option, Schema, Stream } from "effect"
import { AiError, McpSchema, McpServer, Tool, type Toolkit } from "effect/ai"
import { HttpServerRequest } from "effect/http"
import { McpCredentials } from "../credentials.ts"

export class CallingThread extends Context.Service<CallingThread, string>()("hinacode/mcp/CallingThread") {}

const Output = Schema.Union([Schema.String, Schema.Array(McpSchema.ContentBlock)])

const Failure = Schema.Struct({ message: Schema.String })

export const text = (value: string, isError = false) =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text: value }], isError })

const toolResult = (output: typeof Output.Type) =>
  typeof output === "string" ? text(output) : new McpSchema.CallToolResult({ content: output, isError: false })

const errorMessage = (error: { readonly message: string }) =>
  AiError.isAiError(error) && error.reason._tag === "ToolParameterValidationError"
    ? error.reason.description
    : error.message

export const invalidCredential = text("The MCP credential is not valid for any thread.", true)

// FIXME: McpServer runs handlers in the request fiber without declaring it in their type
export const callingThreadId = (credentials: typeof McpCredentials.Service) =>
  Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
    Option.flatMap(request, (current) => credentials.authenticate(current.headers["authorization"])),
  )

// FIXME: `McpServer.toolkit` JSON-encodes every result, which quotes text and cannot return images
export const toolsFor = <Caller, R>(
  caller: Context.Key<Caller, string>,
  options: {
    readonly resolve: Effect.Effect<Option.Option<string>, never, R>
    readonly invalid: McpSchema.CallToolResult
  },
) => {
  const make = <const Name extends string, Parameters extends Schema.Constraint = Tool.EmptyParams>(
    name: Name,
    { description, parameters }: { readonly description: string; readonly parameters?: Parameters },
  ) => Tool.make(name, { description, parameters, success: Output, failure: Failure, dependencies: [caller] })

  const register = Effect.fnUntraced(function* <
    Tools extends Record<string, ReturnType<typeof make<string, Schema.Top>>>,
  >(toolkit: Toolkit.Toolkit<Tools>, annotations: Context.Context<never> = Context.empty()) {
    const server = yield* McpServer.McpServer
    const resolve = Effect.provide(options.resolve, yield* Effect.context<R>())
    const built = yield* toolkit
    // FIXME: `Tool.HandlerServices` and `Tool.Result` do not reduce for a generic `Tools`
    const handle = built.handle as unknown as (
      name: string,
      payload: unknown,
    ) => Effect.Effect<
      Stream.Stream<{ readonly result: typeof Output.Type }, { readonly message: string }, Caller>,
      { readonly message: string },
      Caller
    >
    yield* Effect.forEach(Object.values(built.tools), (tool) =>
      server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: tool.description,
          inputSchema: Schema.decodeUnknownSync(McpSchema.ToolJson)(Tool.getJsonSchema(tool)),
          annotations: { readOnlyHint: Context.get(tool.annotations, Tool.Readonly) },
        }),
        annotations,
        handle: (payload) =>
          Effect.gen(function* () {
            const callerId = yield* resolve
            if (Option.isNone(callerId)) return options.invalid
            return yield* handle(tool.name, payload ?? {}).pipe(
              Stream.unwrap,
              Stream.runLast,
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(caller, callerId.value),
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

  return { make, register }
}

export const { make, register } = toolsFor(CallingThread, {
  resolve: Effect.flatMap(McpCredentials, callingThreadId),
  invalid: invalidCredential,
})
