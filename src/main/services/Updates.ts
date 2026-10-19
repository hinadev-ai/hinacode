import { Context, Effect } from "effect"
import type { UpdateStatus } from "../../shared/domain.ts"

/** Release checks. The desktop app provides `updater.ts`; a cloud updates by replacing its package. */
export class Updates extends Context.Service<
  Updates,
  {
    readonly status: Effect.Effect<UpdateStatus>
    /** Does nothing while a check or download runs, or while a downloaded release waits to install. */
    readonly check: Effect.Effect<void>
    readonly install: Effect.Effect<void>
  }
>()("hinacode/Updates") {}

/** For a build that never updates in place: a development build, or a cloud. */
export const unsupported = (current: string) =>
  Updates.of({
    status: Effect.succeed({ current, state: { type: "unsupported" } }),
    check: Effect.void,
    install: Effect.void,
  })
