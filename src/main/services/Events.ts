import { BrowserWindow } from "electron"
import { Context, Effect, Layer, Schema } from "effect"
import { EVENT_CHANNEL } from "../../shared/channels.ts"
import { PushEvent } from "../../shared/contract.ts"

/** Main -> renderer pushes, sent to every open window. */
export class Events extends Context.Service<Events, { readonly publish: (event: PushEvent) => Effect.Effect<void> }>()(
  "kkcode/Events",
) {}

const encode = Schema.encodeSync(PushEvent)

export const layer = Layer.succeed(
  Events,
  Events.of({
    publish: (event) =>
      Effect.sync(() => {
        const encoded = encode(event)
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EVENT_CHANNEL, encoded)
      }),
  }),
)
