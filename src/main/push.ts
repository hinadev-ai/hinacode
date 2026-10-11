import { BrowserWindow } from "electron"
import { Context, Effect, Layer, Schema } from "effect"
import { EVENT_CHANNEL } from "../shared/channels.ts"
import { PushEvent } from "../shared/contract.ts"

/** Sends main -> renderer events to every open window. A service so producers stay testable. */
export class Push extends Context.Service<Push, { readonly publish: (event: PushEvent) => Effect.Effect<void> }>()(
  "kkcode/Push",
) {}

const encode = Schema.encodeSync(PushEvent)

export const layer = Layer.succeed(
  Push,
  Push.of({
    publish: (event) =>
      Effect.sync(() => {
        const encoded = encode(event)
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EVENT_CHANNEL, encoded)
      }),
  }),
)
