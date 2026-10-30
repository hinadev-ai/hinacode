import { Effect, Option, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { AgentRunner } from "../../services/AgentRunner.ts"
import * as McpTool from "./tool.ts"

const SecretName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).annotate({
  description:
    "File name the value is saved under, for example STRIPE_API_KEY. Letters, digits, dots, dashes and underscores.",
})

export const SecretTools = Toolkit.make(
  McpTool.make("request_secret", {
    description:
      "Ask the user for a secret (API key, token, password) instead of asking them to paste it into the chat. Call it as soon as you need one, or when the user asks how to give you one, instead of explaining. HinaCode shows them a masked input in this thread, writes what they enter to a file in your scratch directory and returns its path. Read the file inside the command that needs the value, for example `STRIPE_API_KEY=\"$(cat '<path>')\" ./script`, and never print it. Blocks until they answer or the turn ends.",
    parameters: Schema.Struct({
      name: SecretName,
      description: Schema.String.annotate({ description: "What the secret is for, shown to the user." }),
    }),
  }),
)

export const secretToolsLayer = SecretTools.toLayer(
  Effect.gen(function* () {
    const runner = yield* AgentRunner
    return SecretTools.of({
      request_secret: ({ name, description }) =>
        Effect.gen(function* () {
          const threadId = yield* McpTool.CallingThread
          const path = yield* runner.requestSecret(threadId, name, description)
          if (Option.isNone(path))
            return yield* Effect.fail({ message: `The user declined to provide secret "${name}".` })
          return `Saved secret "${name}" to '${path.value}'. Read it from that file in the command that needs it, and never print it.`
        }),
    })
  }),
)
