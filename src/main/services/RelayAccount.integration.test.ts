import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import type { RelayMachine } from "../../shared/relayMachines.ts"
import * as Db from "../db/client.ts"
import * as RemoteAccess from "../remote/access.ts"
import type { Fetch } from "../remote/relayService.ts"
import * as Environments from "./Environments.ts"
import { makeEventsLayer } from "./Events.ts"
import * as RelayAccount from "./RelayAccount.ts"
import * as Secrets from "./Secrets.ts"
import * as Settings from "./Settings.ts"

const SERVICE_URL = "https://relay.test"
const OWNER_TOKEN = "owner-token"

/** 192.0.2.1 never answers, so the machines stay offline for the whole test. */
const homeServer: RelayMachine = {
  environmentId: "home-server",
  name: "home-server",
  pairing: { hosts: ["192.0.2.1"], port: 48081, token: "machine-token", relay: "home-server.relay.invalid" },
}

interface StandInRelay {
  ownerToken: string
  machines: ReadonlyArray<RelayMachine>
  readonly fetch: Fetch
}

/** A stand-in relay service that lists `machines` to whoever holds `ownerToken`. */
const standInRelay = () => {
  const relay: StandInRelay = {
    ownerToken: OWNER_TOKEN,
    machines: [homeServer],
    fetch: async (url, init) => {
      if (url.href !== `${SERVICE_URL}/v1/machines` || init.method !== "GET") return new Response(null, { status: 404 })
      if (new Headers(init.headers).get("Authorization") !== `Bearer ${relay.ownerToken}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 })
      }
      return Response.json({ machines: relay.machines })
    },
  }
  return relay
}

const withAccount = <A, E>(
  relay: StandInRelay,
  effect: Effect.Effect<
    A,
    E,
    RelayAccount.RelayAccount | Environments.Environments | Secrets.Secrets | Effect.Services<typeof Settings.layer>
  >,
) =>
  effect.pipe(
    Effect.provide(
      RelayAccount.layer({ serviceUrl: SERVICE_URL, fetch: relay.fetch }).pipe(
        Layer.provideMerge(Environments.layer),
        Layer.provideMerge(RemoteAccess.layer),
        Layer.provideMerge(Secrets.layer),
        Layer.provideMerge(Settings.layer),
        Layer.provideMerge(makeEventsLayer(() => {})),
        Layer.provideMerge(Db.layer(":memory:")),
        Layer.provide(Layer.mergeAll(NodeServices.layer, Secrets.noKeyring)),
      ),
    ),
  )

const account = RelayAccount.RelayAccount
const listed = Environments.Environments.use((environments) => environments.list).pipe(
  Effect.map(({ clouds }) => clouds.map(({ id, source }) => ({ id, source }))),
)
const storedOwnerToken = Secrets.Secrets.use((secrets) => secrets.get("relay.ownerToken")).pipe(
  Effect.map(Option.getOrNull),
)

describe("RelayAccount", () => {
  it.live("signing in with the owner token keeps it and adds every machine the relay lists", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const status = yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        expect(status).toStrictEqual({
          state: "signedIn",
          serviceUrl: SERVICE_URL,
          machines: 1,
          syncedAt: expect.any(String),
          error: null,
        })
        expect(yield* storedOwnerToken).toBe(OWNER_TOKEN)
        expect(yield* listed).toStrictEqual([{ id: "home-server", source: "relay" }])
      }),
    )
  })

  it.live("a refused owner token at sign-in keeps nothing and says where the current one is", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const error = yield* account.use((relayAccount) => relayAccount.signIn("stale")).pipe(Effect.flip)

        expect(error.message).toMatch(/owner token.*relay page/)
        expect(yield* storedOwnerToken).toBeNull()
        expect(yield* listed).toStrictEqual([])
        expect(yield* account.use((relayAccount) => relayAccount.status)).toStrictEqual({ state: "signedOut" })
      }),
    )
  })

  it.live("a refused owner token at sync keeps every machine and says why", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))
        relay.ownerToken = "rotated"
        relay.machines = []

        const status = yield* account.use((relayAccount) => relayAccount.sync)

        expect(status).toMatchObject({ state: "signedIn", machines: 1, error: expect.stringMatching(/owner token/) })
        expect(yield* listed).toStrictEqual([{ id: "home-server", source: "relay" }])
      }),
    )
  })

  it.live("signing out drops the relay's machines and forgets the owner token", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        expect(yield* account.use((relayAccount) => relayAccount.signOut)).toStrictEqual({ state: "signedOut" })
        expect(yield* storedOwnerToken).toBeNull()
        expect(yield* listed).toStrictEqual([])
      }),
    )
  })
})
