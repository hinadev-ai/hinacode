import { Context, Effect, Layer } from "effect"
import { McpSchema, Toolkit } from "effect/ai"
import { Devices } from "../../services/devices/Devices.ts"
import { TinyVm } from "../../services/tinyVm/TinyVm.ts"
import { AgentTools, agentToolsLayer } from "./agents.ts"
import { DeviceTools, deviceToolsLayer } from "./devices.ts"
import { LinearTools, linearToolsLayer } from "./linear.ts"
import { PullRequestTools, pullRequestToolsLayer } from "./pullRequests.ts"
import { ReviewTools, reviewToolsLayer } from "./reviewChanges.ts"
import { SecretTools, secretToolsLayer } from "./secrets.ts"
import { ThreadTools, threadToolsLayer } from "./threads.ts"
import { VmTools, vmToolsLayer } from "./tinyVm.ts"
import * as McpTool from "./tool.ts"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tinyVm = yield* TinyVm
    const devices = yield* Devices
    yield* McpTool.register(
      Toolkit.merge(SecretTools, ThreadTools, AgentTools, ReviewTools, PullRequestTools, LinearTools),
    )
    yield* McpTool.register(
      VmTools,
      Context.make(McpSchema.EnabledWhen, () => tinyVm.enabled()),
    )
    yield* McpTool.register(
      DeviceTools,
      Context.make(McpSchema.EnabledWhen, () => devices.enabled()),
    )
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      secretToolsLayer,
      threadToolsLayer,
      agentToolsLayer,
      reviewToolsLayer,
      pullRequestToolsLayer,
      linearToolsLayer,
      vmToolsLayer,
      deviceToolsLayer,
    ),
  ),
)
