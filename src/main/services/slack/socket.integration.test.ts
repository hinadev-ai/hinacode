import { type AddressInfo, createServer as createTcpServer, type Server } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Queue } from "effect"
import { makeSlackApi } from "./api.ts"
import { type FakeWorkspace, makeFakeSlack } from "./fakeSlack.ts"
import { listen } from "./socket.ts"

const workspace: FakeWorkspace = {
  appToken: "xapp-1-app",
  botToken: "xoxb-bot",
  team: { id: "T1", name: "Acme" },
  bot: "hinacode",
  users: {},
}

describe("slack socket", () => {
  it.live("replaces a socket Slack has stopped pinging", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSlack(workspace)
      const lives: Array<boolean> = []
      yield* listen({
        open: makeSlackApi(fake.apiUrl).openConnection(workspace.appToken),
        onLive: (live) => void lives.push(live),
        onEnvelope: () => Effect.void,
        serverSilenceMs: 50,
      }).pipe(Effect.forkScoped)

      const silent = yield* Queue.take(fake.links)
      const replacement = yield* Queue.take(fake.links)
      expect(replacement).not.toBe(silent)
      expect(lives.slice(0, 2)).toEqual([true, false])
    }),
  )

  it.live("gives up on a handshake Slack never finishes and dials again", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSlack(workspace)
      const api = makeSlackApi(fake.apiUrl)
      const stalled = yield* Effect.acquireRelease(
        Effect.callback<Server>((resume) => {
          const server = createTcpServer(() => undefined)
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
        }),
        (server) => Effect.sync(() => void server.close()),
      )
      let dials = 0
      yield* listen({
        open: Effect.suspend(() => {
          dials += 1
          return dials === 1
            ? Effect.succeed(`ws://127.0.0.1:${(stalled.address() as AddressInfo).port}/link`)
            : api.openConnection(workspace.appToken)
        }),
        onLive: () => undefined,
        onEnvelope: () => Effect.void,
        handshakeTimeoutMs: 50,
      }).pipe(Effect.forkScoped)

      yield* Queue.take(fake.links)
      expect(dials).toBe(2)
    }),
  )
})
