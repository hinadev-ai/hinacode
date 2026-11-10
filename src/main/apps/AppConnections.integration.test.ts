import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import type { PushEvent } from "../../shared/contract.ts"
import * as Db from "../db/client.ts"
import { layer as remoteAccessLayer, RemoteAccess } from "../remote/access.ts"
import { Events } from "../services/Events.ts"
import { layer as secretsLayer, noKeyring } from "../services/Secrets.ts"
import { layer as settingsLayer } from "../services/Settings.ts"
import { AppConnections, type ConnectRequest, layer as connectionsLayer } from "./AppConnections.ts"

const asked: ConnectRequest = {
  clientId: "client",
  name: "Chat app",
  redirectUri: "https://chat.example/callback",
  codeChallenge: "challenge",
  state: "state-1",
}
const { state: _, ...grant } = asked

const withConnections = <A, E>(
  effect: (pushes: Array<PushEvent>) => Effect.Effect<A, E, AppConnections | RemoteAccess>,
) => {
  const pushes: Array<PushEvent> = []
  const events = Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })
  return effect(pushes).pipe(
    Effect.provide(
      connectionsLayer.pipe(
        Layer.provideMerge(remoteAccessLayer),
        Layer.provide(secretsLayer.pipe(Layer.provide(noKeyring))),
        Layer.provide(Layer.suspend(() => settingsLayer(mkdtempSync(join(tmpdir(), "kk-apps-settings-"))))),
        Layer.provide(events),
        Layer.provide(Db.layer(":memory:")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  )
}

const approved = Effect.gen(function* () {
  const connections = yield* AppConnections
  yield* connections.start
  const id = Option.getOrThrow(yield* connections.request(asked))
  yield* connections.answer({ id, approve: true })
  const outcome = yield* connections.outcome(id)
  return outcome.type === "approved" ? outcome.authorizationCode : ""
})

describe("app connections", () => {
  it.effect("has no url until the relay has a hostname", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        expect(yield* connections.status).toEqual({ url: null, waitingUntil: null, requests: [], connections: [] })
        yield* RemoteAccess.use((access) =>
          access.report({ relay: { state: "connected", hostname: "desk.relay.example" } }),
        )
        expect((yield* connections.status).url).toBe("https://desk.relay.example/mcp")
        expect(yield* connections.issuer).toEqual(Option.some("https://desk.relay.example"))
      }),
    ),
  )

  it.effect("waits ten minutes for the app the developer chose", () =>
    withConnections((pushes) =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        expect(yield* connections.inUse).toBe(false)
        expect(yield* connections.request(asked)).toEqual(Option.none())
        expect((yield* connections.start).waitingUntil).toBe("1970-01-01T00:10:00.000Z")
        expect(yield* connections.inUse).toBe(true)

        yield* TestClock.adjust("9 minutes")
        const id = Option.getOrThrow(yield* connections.request(asked))
        expect((yield* connections.status).requests).toEqual([{ id, name: "Chat app", redirectHost: "chat.example" }])
        expect(yield* connections.outcome(id)).toEqual({ type: "waiting", request: asked })

        pushes.length = 0
        yield* TestClock.adjust("1 minute")
        expect(pushes).toEqual([
          {
            type: "appConnections.changed",
            status: { url: null, waitingUntil: null, requests: [], connections: [] },
          },
        ])
        expect(yield* connections.outcome(id)).toEqual({ type: "unknown" })
        expect(yield* connections.inUse).toBe(false)
      }),
    ),
  )

  it.effect("hands the answer to the waiting page once", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        yield* connections.start
        const id = Option.getOrThrow(yield* connections.request(asked))
        yield* connections.answer({ id, approve: false })
        expect(yield* connections.outcome(id)).toEqual({ type: "denied", request: asked })
        expect(yield* connections.outcome(id)).toEqual({ type: "unknown" })
        yield* connections.answer({ id, approve: true })
        expect(yield* connections.outcome(id)).toEqual({ type: "unknown" })
      }),
    ),
  )

  it.effect("redeems an authorization code once, within sixty seconds", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        const used = yield* approved
        expect(yield* connections.inUse).toBe(true)
        expect(yield* connections.redeem(used)).toEqual(Option.some(grant))
        expect(yield* connections.redeem(used)).toEqual(Option.none())
        expect(yield* connections.inUse).toBe(false)

        const late = yield* approved
        yield* TestClock.adjust("60 seconds")
        expect(yield* connections.inUse).toBe(false)
        expect(yield* connections.redeem(late)).toEqual(Option.none())
      }),
    ),
  )

  it.effect("authenticates a connection's token until it is removed", () =>
    withConnections((pushes) =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        yield* TestClock.adjust("1 hour")
        const { id, token } = yield* connections.connect("Chat app")
        expect(pushes.at(-1)).toEqual({
          type: "appConnections.changed",
          status: {
            url: null,
            waitingUntil: null,
            requests: [],
            connections: [{ id, name: "Chat app", createdAt: "1970-01-01T01:00:00.000Z", lastUsedAt: null }],
          },
        })
        expect(yield* connections.inUse).toBe(true)

        yield* TestClock.adjust("1 hour")
        expect(yield* connections.authenticate(`Bearer ${token}`)).toEqual(Option.some(id))
        expect(yield* connections.authenticate(`Bearer ${token}x`)).toEqual(Option.none())
        expect(yield* connections.authenticate(token)).toEqual(Option.none())
        expect(yield* connections.authenticate(undefined)).toEqual(Option.none())
        expect((yield* connections.status).connections[0]?.lastUsedAt).toBe("1970-01-01T02:00:00.000Z")

        expect((yield* connections.remove(id)).connections).toEqual([])
        expect(yield* connections.authenticate(`Bearer ${token}`)).toEqual(Option.none())
        expect(yield* connections.inUse).toBe(false)
      }),
    ),
  )
})
