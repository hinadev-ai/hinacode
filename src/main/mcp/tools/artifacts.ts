import { ArtifactError, type ArtifactTool, artifactTools } from "@hinacode/artifacts"
import { Context, Effect, Option, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { publishedArtifactId } from "../../../shared/agent.ts"
import { ARTIFACT_THEME_GUIDE } from "../../../shared/artifactTheme.ts"
import { ArtifactInspector, describeInspection } from "../../services/ArtifactInspector.ts"
import { Artifacts } from "../../services/Artifacts.ts"
import { McpCredentials } from "../credentials.ts"
import { callingThreadId, invalidCredential, text } from "./tool.ts"

const decodeInputSchema = Schema.decodeUnknownSync(McpSchema.ToolJson)

const invalidInput = (issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>) =>
  text(issues.map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`).join("\n"), true)

export const registerArtifactTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer
  const credentials = yield* McpCredentials
  const { store } = yield* Artifacts
  const inspector = yield* ArtifactInspector

  const withInspection = (result: string) =>
    Effect.gen(function* () {
      const id = publishedArtifactId(result)
      const artifact = id === null ? null : yield* Effect.promise(() => store.get(id))
      const inspection = artifact === null ? null : yield* inspector.inspect(artifact.id, artifact.entry)
      if (inspection === null) return text(result)
      return new McpSchema.CallToolResult({
        content: [
          { type: "text", text: `${result}\n\n${describeInspection(inspection)}` },
          { type: "image", ...inspection.screenshot },
        ],
        isError: false,
      })
    })
  yield* Effect.forEach(Object.entries<ArtifactTool>(artifactTools), ([name, tool]) =>
    server.addTool({
      tool: new McpSchema.Tool({
        name,
        description: name === "publish_artifact" ? `${tool.description}\n\n${ARTIFACT_THEME_GUIDE}` : tool.description,
        inputSchema: decodeInputSchema(tool.input.toJSONSchema()),
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        Effect.gen(function* () {
          if (Option.isNone(yield* callingThreadId(credentials))) return invalidCredential
          const input = tool.input.safeParse(payload ?? {})
          if (!input.success) return invalidInput(input.error.issues)
          return yield* Effect.tryPromise({ try: () => tool.handle(store, input.data), catch: (cause) => cause }).pipe(
            Effect.flatMap((result) =>
              name === "publish_artifact" ? withInspection(result) : Effect.succeed(text(result)),
            ),
            Effect.catch((cause) =>
              cause instanceof ArtifactError
                ? Effect.succeed(text(cause.message, true))
                : Effect.as(
                    Effect.logError("mcp tool failed", name, cause),
                    text(`${name} failed unexpectedly. See the HinaCode logs.`, true),
                  ),
            ),
          )
        }),
    }),
  )
})
