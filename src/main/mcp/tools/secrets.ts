import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { AgentRunner } from "../../services/AgentRunner.ts"
import * as McpTool from "./tool.ts"

const SecretName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).annotate({
  description:
    "Name the value is stored under, for example stripe.apiKey. Letters, digits, dots, dashes and underscores.",
})

export const SecretTools = Toolkit.make(
  McpTool.make("request_secret", {
    description:
      "Ask the user for a secret (API key, token, password). KKCode shows them a masked input in this thread and stores what they enter under `name`. The value is never returned to you: tell the user where the stored secret is needed instead of asking them to paste it into the chat. Blocks until they answer or the turn ends.",
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
          const outcome = yield* runner.requestSecret(threadId, name, description)
          if (outcome !== "stored")
            return yield* Effect.fail({ message: `The user declined to provide secret "${name}".` })
          return `Stored secret "${name}". The value is never returned to you; tell the user which setting or environment variable needs it.`
        }),
    })
  }),
)
