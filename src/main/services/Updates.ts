import { Context, Effect } from "effect"
import type { UpdateStatus } from "../../shared/domain.ts"

export class Updates extends Context.Service<
  Updates,
  {
    readonly status: Effect.Effect<UpdateStatus>
    readonly check: Effect.Effect<void>
    readonly install: Effect.Effect<void>
  }
>()("hinacode/Updates") {}

export const unsupported = (current: string) =>
  Updates.of({
    status: Effect.succeed({ current, state: { type: "unsupported" } }),
    check: Effect.void,
    install: Effect.void,
  })
