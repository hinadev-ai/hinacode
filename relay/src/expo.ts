import { Option, Schema } from "effect"
import type { Fetch } from "./cloudflare"

/** An Expo call that failed. `message` is a sentence the relay returns as its 502 body. */
export class ExpoError extends Error {}

export interface PushMessage {
  readonly to: string
  readonly title: string
  readonly body: string
  readonly data: { readonly threadId: string; readonly environmentId: string }
  readonly sound: "default"
  readonly priority: "high"
  readonly channelId: "threads"
}

const SEND = new URL("https://exp.host/--/api/v2/push/send")
const CHUNK = 100

const Ticket = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({
    status: Schema.Literal("error"),
    message: Schema.String,
    details: Schema.optionalKey(Schema.Struct({ error: Schema.optionalKey(Schema.String) })),
  }),
])
const Tickets = Schema.Struct({ data: Schema.Array(Ticket) })

/** Sends the messages and answers the tokens Expo says are no longer registered. */
export const sendPushes = async (fetch: Fetch, messages: ReadonlyArray<PushMessage>) => {
  const unregistered: string[] = []
  for (let start = 0; start < messages.length; start += CHUNK) {
    const chunk = messages.slice(start, start + CHUNK)
    let response: Response
    try {
      response = await fetch(SEND, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(chunk),
      })
    } catch {
      throw new ExpoError("Cannot reach the Expo push service.")
    }
    const tickets = Schema.decodeUnknownOption(Tickets)(await response.json().catch(() => undefined))
    if (!response.ok || Option.isNone(tickets)) {
      throw new ExpoError(`The Expo push service answered HTTP ${response.status}.`)
    }
    tickets.value.data.forEach((ticket, index) => {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        unregistered.push(chunk[index]!.to)
      }
    })
  }
  return unregistered
}
