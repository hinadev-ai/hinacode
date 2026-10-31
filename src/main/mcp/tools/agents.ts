import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { ProviderId, RUN_AGENT_TOOL } from "../../../shared/agent.ts"
import { AgentRunner } from "../../services/AgentRunner.ts"
import * as McpTool from "./tool.ts"

export const AgentTools = Toolkit.make(
  McpTool.make(RUN_AGENT_TOOL, {
    description:
      "Run a sub-agent on any provider HinaCode supports, such as Codex from a Claude thread, through its SDK in this thread's workspace. Use it instead of running the `codex` or `claude` CLI in a shell. It shows in this thread's Agents tab, where the user can watch and stop it, and this call waits for it to finish and returns its final reply. Defaults to that provider's first model, or this thread's model on the same provider.",
    parameters: Schema.Struct({
      provider: ProviderId,
      description: Schema.String.annotate({ description: "A few words shown as the sub-agent's label." }),
      prompt: Schema.String.annotate({ description: "The task. The sub-agent sees nothing else of this thread." }),
      model: Schema.optionalKey(Schema.String.annotate({ description: "Model id for that provider." })),
      effort: Schema.optionalKey(
        Schema.String.annotate({ description: "Reasoning effort, such as low, medium or high." }),
      ),
    }),
  }),
)

export const agentToolsLayer = AgentTools.toLayer(
  Effect.gen(function* () {
    const runner = yield* AgentRunner
    return AgentTools.of({
      [RUN_AGENT_TOOL]: (request) =>
        Effect.gen(function* () {
          const threadId = yield* McpTool.CallingThread
          const reply = yield* runner.runAgent(threadId, request)
          return reply === "" ? "The agent finished without a reply." : reply
        }).pipe(Effect.mapError((error) => ({ message: error.message }))),
    })
  }),
)
