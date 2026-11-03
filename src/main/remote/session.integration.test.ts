import { createServer } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { listenWebSockets, retryUntilAddressIsUp } from "./session.ts"
import { unusedLoopbackPort } from "./testing.ts"

const NEVER_ASSIGNED = "192.0.2.1"

const listenOn = (port: number, hosts: Array<string>, attempts: Array<string>) =>
  listenWebSockets({
    listen: (server, listening) => {
      const host = hosts[Math.min(attempts.length, hosts.length - 1)]!
      attempts.push(host)
      server.listen(port, host, listening)
    },
    accept: () => {},
    perMessageDeflate: false,
  })

describe("retryUntilAddressIsUp", () => {
  it.live("keeps retrying a bind on an address that is not up yet, then listens once it is", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(unusedLoopbackPort)
      const attempts: Array<string> = []
      const { server } = yield* listenOn(port, [NEVER_ASSIGNED, NEVER_ASSIGNED, "127.0.0.1"], attempts).pipe(
        retryUntilAddressIsUp,
      )
      expect(attempts).toEqual([NEVER_ASSIGNED, NEVER_ASSIGNED, "127.0.0.1"])
      expect(server.address()).toMatchObject({ address: "127.0.0.1", port })
    }).pipe(Effect.scoped),
  )

  it.live("fails at once when the port is taken", () =>
    Effect.gen(function* () {
      const occupied = createServer()
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => void occupied.listen(0, "127.0.0.1", () => resume(Effect.void))),
        () => Effect.sync(() => occupied.close()),
      )
      const { port } = occupied.address() as { port: number }
      const attempts: Array<string> = []
      const error = yield* listenOn(port, ["127.0.0.1"], attempts).pipe(retryUntilAddressIsUp, Effect.flip)
      expect(error.message).toContain("EADDRINUSE")
      expect(attempts).toEqual(["127.0.0.1"])
    }).pipe(Effect.scoped),
  )
})
