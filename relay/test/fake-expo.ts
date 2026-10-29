import type { Fetch } from "../src/app"

/** Expo's push service, kept in memory. */
export class FakeExpo {
  /** Each request's messages, in order. */
  readonly requests: unknown[][] = []
  /** Tokens Expo answers with DeviceNotRegistered. */
  readonly unregistered = new Set<string>()
  failing = false

  get messages() {
    return this.requests.flat()
  }

  readonly fetch: Fetch = async (input, init) => {
    if (input.href !== "https://exp.host/--/api/v2/push/send") throw new Error(`Unexpected Expo call ${input.href}`)
    const headers = new Headers(init.headers)
    if (init.method !== "POST" || headers.get("Content-Type") !== "application/json") {
      throw new Error("Expo expects a JSON POST")
    }
    if (headers.get("Accept") !== "application/json") throw new Error("Expo answers JSON only when asked")
    const messages = JSON.parse(init.body as string) as { to: string }[]
    this.requests.push(messages)
    if (this.failing) return Response.json({ errors: [{ code: "INTERNAL_SERVER_ERROR" }] }, { status: 500 })
    return Response.json({
      data: messages.map((message, index) =>
        this.unregistered.has(message.to)
          ? {
              status: "error",
              message: `"${message.to}" is not a registered push notification recipient`,
              details: { error: "DeviceNotRegistered" },
            }
          : { status: "ok", id: `ticket-${index}` },
      ),
    })
  }
}
