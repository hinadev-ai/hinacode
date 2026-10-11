import { Context, type Effect } from "effect"
import type { PushEvent } from "../../shared/contract.ts"

/** Main -> renderer pushes, sent to every open window. The Electron-backed layer lives in `ipc.ts`. */
export class Events extends Context.Service<Events, { readonly publish: (event: PushEvent) => Effect.Effect<void> }>()(
  "kkcode/Events",
) {}
