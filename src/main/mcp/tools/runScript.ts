import { Context, Effect, Option, Predicate, Schema } from "effect"
import { McpSchema, McpServer, Toolkit } from "effect/ai"
import { DEFAULT_LIMITS, type HostFunction, runScript, withTimeout } from "@hinacode/sandbox"
import { RUN_AGENT_TOOL, WAIT_AGENT_TOOL } from "../../../shared/agent.ts"
import * as McpTool from "./tool.ts"

export const RUN_SCRIPT_TOOL = "run_script"

const SCRIPT_LIMITS = { timeoutMs: 4 * 60_000, callTimeoutMs: 2 * 60_000 }

const WAITS_UNTIL_DEADLINE = new Set([RUN_AGENT_TOOL, WAIT_AGENT_TOOL, "request_secret", "review_changes", "vm_exec"])

export const ScriptTools = Toolkit.make(
  McpTool.make(RUN_SCRIPT_TOOL, {
    description: `Run JavaScript in a QuickJS sandbox that calls this server's other tools, so you can chain calls, run them in parallel and filter large results before they reach your context. The code is the body of an async function, so \`await\` and \`return\` work at the top level. Each tool this server lists is \`tools.<name>(args)\` with the same arguments. It resolves to the tool's structured content, else its text, else its content blocks, and rejects with an Error carrying the tool's message when it fails. \`console.log\` lines and the returned value make up the result. There is no file system, network, \`setTimeout\`, \`require\` or \`process\`, and \`run_script\` cannot call itself. Calls are real and are not undone when the script fails. \`await sleep(ms)\` waits, for polling. A tool call that takes more than ${SCRIPT_LIMITS.callTimeoutMs / 60_000} minutes rejects with a timeout Error you can catch, except ${[...WAITS_UNTIL_DEADLINE].map((name) => `\`${name}\``).join(", ")}, which may run until the script's deadline. At most ${DEFAULT_LIMITS.maxConcurrentCalls} calls run at once and the rest wait their turn. The script is stopped after ${SCRIPT_LIMITS.timeoutMs / 60_000} minutes, after computing for more than ${DEFAULT_LIMITS.sliceMs} ms between awaits, or past ${DEFAULT_LIMITS.memoryBytes / 1024 / 1024} MB.`,
    parameters: Schema.Struct({
      code: Schema.String.annotate({
        description:
          "JavaScript, for example `const [a, b] = await Promise.all([tools.x({}), tools.y({})]); return a`.",
      }),
    }),
  }),
)

const visibleTo =
  (client: McpSchema.McpServerClient["Service"]) =>
  ({ annotations }: { readonly annotations: Context.Context<never> }) => {
    const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen)
    return (
      enabledWhen === undefined ||
      enabledWhen({
        protocolVersion: client.protocolVersion,
        capabilities: client.clientCapabilities,
        clientInfo: client.clientInfo,
      })
    )
  }

const encodeContent = Schema.encodeSync(Schema.Array(McpSchema.ContentBlock))

const scriptValue = (result: McpSchema.CallToolResult): Effect.Effect<unknown, Error> => {
  const texts = result.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
  if (result.isError === true) return Effect.fail(new Error(texts.join("\n") || "The tool failed."))
  if (result.structuredContent !== undefined) return Effect.succeed(result.structuredContent)
  return Effect.succeed(texts.length === result.content.length ? texts.join("\n") : encodeContent(result.content))
}

export const scriptToolsLayer = ScriptTools.toLayer(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer
    return ScriptTools.of({
      [RUN_SCRIPT_TOOL]: ({ code }) =>
        Effect.gen(function* () {
          const client = yield* Effect.serviceOption(McpSchema.McpServerClient)
          if (Option.isNone(client)) return yield* Effect.fail({ message: "run_script needs an MCP session." })
          const context = yield* Effect.context<never>()
          const callTool =
            (name: string): HostFunction =>
            ([args = {}], signal) =>
              Predicate.isObject(args) && !Array.isArray(args)
                ? Effect.runPromiseWith(context)(
                    server
                      .callTool({ name, arguments: args as Record<string, unknown> })
                      .pipe(
                        Effect.flatMap(scriptValue),
                        Effect.provideService(McpSchema.McpServerClient, client.value),
                      ),
                    { signal },
                  )
                : Promise.reject(new Error(`${name} takes one object of arguments.`))
          const tools = Object.fromEntries(
            server.tools
              .filter(visibleTo(client.value))
              .map(({ tool }) => tool.name)
              .filter((name) => name !== RUN_SCRIPT_TOOL)
              .map((name) => [
                name,
                WAITS_UNTIL_DEADLINE.has(name) ? withTimeout(callTool(name), Number.POSITIVE_INFINITY) : callTool(name),
              ]),
          )
          const outcome = yield* Effect.tryPromise((signal) =>
            runScript({ code, globals: { tools }, signal, limits: SCRIPT_LIMITS }),
          ).pipe(Effect.mapError((error) => ({ message: error.message })))
          if (outcome._tag === "Failed")
            return yield* Effect.fail({
              message: [outcome.output, `Script error: ${outcome.error}`].filter((part) => part !== "").join("\n\n"),
            })
          return outcome.output === "" ? "The script finished without output." : outcome.output
        }),
    })
  }),
)
