import { Context, type Effect, type Scope } from "effect"
import type { PushEvent } from "../../shared/contract.ts"

/** Main -> renderer pushes, sent to every open window. The Electron-backed layer lives in `ipc.ts`. */
export class Events extends Context.Service<Events, { readonly publish: (event: PushEvent) => Effect.Effect<void> }>()(
  "kkcode/Events",
) {}

/** The encoded pushes, for a second transport. Releasing the scope unsubscribes. */
export class PushBroadcast extends Context.Service<
  PushBroadcast,
  { readonly subscribe: (sink: (event: typeof PushEvent.Encoded) => void) => Effect.Effect<void, never, Scope.Scope> }
>()("kkcode/PushBroadcast") {}
