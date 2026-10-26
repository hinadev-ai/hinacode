import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import type { PendingLink, RelayHost, RelayMachine } from "../../shared/relayMachines.ts"
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

const homeServerHost: RelayHost = {
  id: "host-1",
  environmentId: "home-server",
  name: "home-server",
  hostname: "home-server.relay.invalid",
  createdAt: 0,
  enabled: true,
  published: true,
}

interface StandInRelay {
  ownerToken: string
  machines: ReadonlyArray<RelayMachine>
  hosts: Array<RelayHost>
  /** Link codes waiting for approval, by user code. */
  readonly links: Map<string, PendingLink>
  readonly approved: Array<string>
  /** Runs when a link code is approved, standing in for the machine that waits on it. */
  onApprove: () => void
  /** Runs before each answer to `GET /v1/hosts`. */
  onHostsListed: () => void
  /** Every call as "METHOD /path". */
  readonly calls: Array<string>
  readonly fetch: Fetch
}

/**
 * A stand-in relay service for whoever holds `ownerToken`. `/v1/machines` lists the `machines` whose host is
 * shown, and `/v1/hosts` manages `hosts`.
 */
const standInRelay = () => {
  const hostById = (id: string) => relay.hosts.find((host) => host.id === id)
  const route = async (method: string, path: string, init: RequestInit): Promise<Response> => {
    if (method === "GET" && path === "/v1/machines") {
      const shown = (machine: RelayMachine) =>
        relay.hosts.find((host) => host.environmentId === machine.environmentId)?.enabled !== false
      return Response.json({ machines: relay.machines.filter(shown) })
    }
    if (method === "GET" && path === "/v1/hosts") {
      relay.onHostsListed()
      return Response.json({ hosts: relay.hosts })
    }
    const hostId = path.match(/^\/v1\/hosts\/([^/]+)$/)?.[1]
    if (hostId !== undefined) {
      const host = hostById(hostId)
      if (host === undefined) return Response.json({ error: "No such machine." }, { status: 404 })
      if (method === "PATCH") {
        const { enabled } = JSON.parse(String(init.body)) as { enabled: boolean }
        relay.hosts = relay.hosts.map((each) => (each.id === hostId ? { ...each, enabled } : each))
        return new Response(null, { status: 204 })
      }
      if (method === "DELETE") {
        relay.hosts = relay.hosts.filter((each) => each.id !== hostId)
        relay.machines = relay.machines.filter((machine) => machine.environmentId !== host.environmentId)
        return new Response(null, { status: 204 })
      }
    }
    const userCode = path.match(/^\/v1\/links\/([^/]+)$/)?.[1]
    if (userCode !== undefined) {
      const link = relay.links.get(userCode)
      if (link === undefined) return Response.json({ error: "That code expired." }, { status: 404 })
      if (method === "GET") return Response.json(link)
      if (method === "POST") {
        relay.links.delete(userCode)
        relay.approved.push(userCode)
        relay.onApprove()
        return new Response(null, { status: 204 })
      }
    }
    return new Response(null, { status: 404 })
  }
  const relay: StandInRelay = {
    ownerToken: OWNER_TOKEN,
    machines: [homeServer],
    hosts: [homeServerHost],
    links: new Map(),
    approved: [],
    onApprove: () => {},
    onHostsListed: () => {},
    calls: [],
    fetch: async (url, init) => {
      const method = init.method ?? "GET"
      relay.calls.push(`${method} ${url.pathname}`)
      if (url.origin !== SERVICE_URL) return new Response(null, { status: 404 })
      if (new Headers(init.headers).get("Authorization") !== `Bearer ${relay.ownerToken}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 })
      }
      return route(method, url.pathname, init)
    },
  }
  return relay
}

const withAccount = <A, E>(
  relay: StandInRelay,
  effect: Effect.Effect<
    A,
    E,
    | RelayAccount.RelayAccount
    | Environments.Environments
    | RemoteAccess.RemoteAccess
    | Secrets.Secrets
    | Effect.Services<typeof Settings.layer>
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
          environmentId: (yield* RemoteAccess.RemoteAccess).identity.id,
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

  it.live("lists every machine linked to the relay", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        expect(yield* account.use((relayAccount) => relayAccount.machines)).toStrictEqual([homeServerHost])
      }),
    )
  })

  it.live("listing the machines while signed out asks to sign in", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const error = yield* account.use((relayAccount) => relayAccount.machines).pipe(Effect.flip)

        expect(error.message).toMatch(/[Ss]ign in/)
        expect(relay.calls).toStrictEqual([])
      }),
    )
  })

  it.live("hiding a machine drops its environment at once and answers the fresh list", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        const hosts = yield* account.use((relayAccount) => relayAccount.setShown({ id: "host-1", enabled: false }))

        expect(relay.calls).toContain("PATCH /v1/hosts/host-1")
        expect(hosts).toStrictEqual([{ ...homeServerHost, enabled: false }])
        expect(yield* listed).toStrictEqual([])
      }),
    )
  })

  it.live("removing another machine deletes it on the relay and drops its environment", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        const hosts = yield* account.use((relayAccount) => relayAccount.removeMachine({ id: "host-1" }))

        expect(relay.calls).toContain("DELETE /v1/hosts/host-1")
        expect(hosts).toStrictEqual([])
        expect(yield* listed).toStrictEqual([])
      }),
    )
  })

  it.live("removing this desktop from here is refused and points to Settings > Remote", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const self = (yield* RemoteAccess.RemoteAccess).identity
        relay.hosts = [...relay.hosts, { ...homeServerHost, id: "host-self", environmentId: self.id, name: self.name }]
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        const error = yield* account
          .use((relayAccount) => relayAccount.removeMachine({ id: "host-self" }))
          .pipe(Effect.flip)

        expect(error.message).toMatch(/Remove relay.*Settings > Remote/)
        expect(relay.calls).not.toContain("DELETE /v1/hosts/host-self")
        expect(relay.hosts.map((host) => host.id)).toStrictEqual(["host-1", "host-self"])
      }),
    )
  })

  it.live("approves a link code, waits for the machine to publish, and adds it at once", () => {
    const relay = standInRelay()
    relay.links.set("ABCD-EFGH", { name: "agent-vm", environmentId: "agent-vm" })
    const agentVm: RelayMachine = { ...homeServer, environmentId: "agent-vm", name: "agent-vm" }
    // The machine claims its credential and publishes its pairing a little after the owner approves it.
    relay.onApprove = () => {
      let polls = 0
      relay.onHostsListed = () => {
        if (++polls !== 2) return
        relay.hosts.push({ ...homeServerHost, id: "host-2", environmentId: "agent-vm", name: "agent-vm" })
        relay.machines = [...relay.machines, agentVm]
      }
    }
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        expect(yield* account.use((relayAccount) => relayAccount.pendingLink("ABCD-EFGH"))).toStrictEqual({
          name: "agent-vm",
          environmentId: "agent-vm",
        })
        const hosts = yield* account.use((relayAccount) => relayAccount.approveLink("ABCD-EFGH"))

        expect(relay.approved).toStrictEqual(["ABCD-EFGH"])
        expect(hosts.map((host) => host.environmentId)).toStrictEqual(["home-server", "agent-vm"])
        expect((yield* listed).map((environment) => environment.id)).toContain("agent-vm")
      }),
    )
  })

  it.live("approves this desktop's own link while signed in", () => {
    const relay = standInRelay()
    relay.links.set("SELF-CODE", { name: "this-desktop", environmentId: "this-desktop" })
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))

        expect(yield* account.use((relayAccount) => relayAccount.approveOwnLink("SELF-CODE"))).toBe(true)
        expect(relay.approved).toStrictEqual(["SELF-CODE"])
      }),
    )
  })

  it.live("does not approve its own link while signed out, and never calls the relay", () => {
    const relay = standInRelay()
    relay.links.set("SELF-CODE", { name: "this-desktop", environmentId: "this-desktop" })
    return withAccount(
      relay,
      Effect.gen(function* () {
        expect(yield* account.use((relayAccount) => relayAccount.approveOwnLink("SELF-CODE"))).toBe(false)
        expect(relay.calls).toStrictEqual([])
      }),
    )
  })

  it.live("a refused owner token on any machine call says to sign in again", () => {
    const relay = standInRelay()
    relay.links.set("ABCD-EFGH", { name: "agent-vm", environmentId: "agent-vm" })
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* account.use((relayAccount) => relayAccount.signIn(OWNER_TOKEN))
        relay.ownerToken = "rotated"

        const calls: Array<Effect.Effect<unknown, { readonly message: string }, RelayAccount.RelayAccount>> = [
          account.use((relayAccount) => relayAccount.machines),
          account.use((relayAccount) => relayAccount.setShown({ id: "host-1", enabled: false })),
          account.use((relayAccount) => relayAccount.removeMachine({ id: "host-1" })),
          account.use((relayAccount) => relayAccount.pendingLink("ABCD-EFGH")),
          account.use((relayAccount) => relayAccount.approveLink("ABCD-EFGH")),
        ]
        for (const call of calls) {
          expect((yield* Effect.flip(call)).message).toMatch(/refused the owner token/)
        }
        expect(yield* account.use((relayAccount) => relayAccount.approveOwnLink("ABCD-EFGH"))).toBe(false)
        expect(relay.approved).toStrictEqual([])
      }),
    )
  })
})
