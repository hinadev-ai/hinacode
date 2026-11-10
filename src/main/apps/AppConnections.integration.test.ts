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
import { AppConnections, type Grant, layer as connectionsLayer } from "./AppConnections.ts"

const grant: Grant = {
  clientId: "client",
  name: "Chat app",
  redirectUri: "https://chat.example/callback",
  codeChallenge: "challenge",
}

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

const liveCode = Effect.gen(function* () {
  const { approvalCode } = yield* AppConnections.use((connections) => connections.newApprovalCode)
  return approvalCode!.code
})

describe("app connections", () => {
  it.effect("has no url until the relay has a hostname", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        expect(yield* connections.status).toEqual({ url: null, approvalCode: null, connections: [] })
        yield* RemoteAccess.use((access) =>
          access.report({ relay: { state: "connected", hostname: "desk.relay.example" } }),
        )
        expect((yield* connections.status).url).toBe("https://desk.relay.example/mcp")
        expect(yield* connections.issuer).toEqual(Option.some("https://desk.relay.example"))
      }),
    ),
  )

  it.effect("mints an eight letter code that lives ten minutes", () =>
    withConnections((pushes) =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        expect(yield* connections.inUse).toBe(false)
        const { approvalCode } = yield* connections.newApprovalCode
        expect(approvalCode?.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
        expect(approvalCode?.expiresAt).toBe("1970-01-01T00:10:00.000Z")
        expect(yield* connections.inUse).toBe(true)

        yield* TestClock.adjust("9 minutes")
        expect((yield* connections.status).approvalCode).toEqual(approvalCode)

        pushes.length = 0
        yield* TestClock.adjust("1 minute")
        expect(pushes).toEqual([
          { type: "appConnections.changed", status: { url: null, approvalCode: null, connections: [] } },
        ])
        expect(yield* connections.approve(approvalCode!.code, grant)).toEqual({ approved: false, codeLive: false })
        expect(yield* connections.inUse).toBe(false)
      }),
    ),
  )

  it.effect("replaces the code when a new one is minted", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        const first = yield* liveCode
        const second = yield* liveCode
        expect(yield* connections.approve(first, grant)).toEqual({ approved: false, codeLive: true })
        expect((yield* connections.approve(second, grant)).approved).toBe(true)
      }),
    ),
  )

  it.effect("accepts the code once, however it is typed", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        const code = yield* liveCode
        expect((yield* connections.approve(` ${code.toLowerCase()} `, grant)).approved).toBe(true)
        expect((yield* connections.status).approvalCode).toBeNull()
        expect(yield* connections.approve(code, grant)).toEqual({ approved: false, codeLive: false })
      }),
    ),
  )

  it.effect("throws the code away after five wrong tries", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        const code = yield* liveCode
        for (let tries = 1; tries <= 4; tries++) {
          expect(yield* connections.approve("WRONGWRONG", grant)).toEqual({ approved: false, codeLive: true })
        }
        expect(yield* connections.approve("WRONGWRONG", grant)).toEqual({ approved: false, codeLive: false })
        expect(yield* connections.approve(code, grant)).toEqual({ approved: false, codeLive: false })
        expect((yield* connections.status).approvalCode).toBeNull()
      }),
    ),
  )

  it.effect("redeems an authorization code once, within sixty seconds", () =>
    withConnections(() =>
      Effect.gen(function* () {
        const connections = yield* AppConnections
        const approve = Effect.gen(function* () {
          const approval = yield* connections.approve(yield* liveCode, grant)
          return approval.approved ? approval.authorizationCode : ""
        })

        const used = yield* approve
        expect(yield* connections.inUse).toBe(true)
        expect(yield* connections.redeem(used)).toEqual(Option.some(grant))
        expect(yield* connections.redeem(used)).toEqual(Option.none())
        expect(yield* connections.inUse).toBe(false)

        const late = yield* approve
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
            approvalCode: null,
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
