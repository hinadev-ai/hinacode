import { Context, Effect, Layer } from "effect"
import { McpSchema, Toolkit } from "effect/ai"
import { TinyVm } from "../../services/tinyVm/TinyVm.ts"
import { LinearTools, linearToolsLayer } from "./linear.ts"
import { PullRequestTools, pullRequestToolsLayer } from "./pullRequests.ts"
import { ReviewTools, reviewToolsLayer } from "./reviewChanges.ts"
import { SecretTools, secretToolsLayer } from "./secrets.ts"
import { ThreadTools, threadToolsLayer } from "./threads.ts"
import { VmTools, vmToolsLayer } from "./tinyVm.ts"
import * as McpTool from "./tool.ts"

export { LINEAR_API_KEY_SECRET } from "./linear.ts"

/** Every tool of the built-in MCP server. The tiny VM tools exist only while its experimental toggle is on. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tinyVm = yield* TinyVm
    yield* McpTool.register(Toolkit.merge(SecretTools, ThreadTools, ReviewTools, PullRequestTools, LinearTools))
    yield* McpTool.register(
      VmTools,
      Context.make(McpSchema.EnabledWhen, () => tinyVm.enabled()),
    )
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      secretToolsLayer,
      threadToolsLayer,
      reviewToolsLayer,
      pullRequestToolsLayer,
      linearToolsLayer,
      vmToolsLayer,
    ),
  ),
)
