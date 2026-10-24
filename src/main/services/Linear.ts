import type { LinearClient } from "@linear/sdk"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { PersistenceError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

export const LINEAR_API_KEY_SECRET = "linear.apiKey"

export class LinearRequestError extends Schema.TaggedError<LinearRequestError>()("LinearRequestError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Linear request failed: ${this.reason}`
  }
}

export const linearRequest = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LinearRequestError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  })

/** This machine's Linear account, through the API key in `Secrets`. */
export class Linear extends Context.Service<
  Linear,
  {
    /**
     * A client for this machine's key, or none when it has no key. The SDK is loaded on the first call: it costs
     * ~30 MB of main-process memory that most sessions never need.
     */
    readonly client: Effect.Effect<Option.Option<LinearClient>, LinearRequestError | PersistenceError>
  }
>()("hinacode/Linear") {}

const make = Effect.gen(function* () {
  const secrets = yield* Secrets

  const client = Effect.flatMap(
    secrets.get(LINEAR_API_KEY_SECRET),
    Option.match({
      onNone: () => Effect.succeedNone,
      onSome: (apiKey) =>
        linearRequest(() => import("@linear/sdk")).pipe(
          Effect.map(({ LinearClient }) => Option.some(new LinearClient({ apiKey }))),
        ),
    }),
  )

  return Linear.of({ client })
})

export const layer = Layer.effect(Linear, make)
