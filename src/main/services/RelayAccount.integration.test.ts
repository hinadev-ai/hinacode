import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import type { RelayHost, RelayMachine } from "../../shared/relayMachines.ts"
import * as Db from "../db/client.ts"
import * as RemoteAccess from "../remote/access.ts"
import type { Fetch } from "../remote/relayService.ts"
import * as Environments from "./Environments.ts"
import { makeEventsLayer } from "./Events.ts"
import * as RelayAccount from "./RelayAccount.ts"
import * as Secrets from "./Secrets.ts"
import * as Settings from "./Settings.ts"

const SERVICE_URL = "https://relay.test"
const CREDENTIAL = "device-credential"

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
  credential: string
  issuedCredential: string
  readonly challenges: Map<string, string>
  profile: { name: string | null; email: string | null }
  machines: ReadonlyArray<RelayMachine>
  hosts: Array<RelayHost>
  readonly links: Map<string, { name: string; environmentId: string }>
  readonly approved: Array<string>
  onApprove: () => void
  onHostsListed: () => void
  readonly calls: Array<string>
  readonly fetch: Fetch
}

const SIGN_IN_CODE = "sign-in-code"

const standInRelay = () => {
  const hostById = (id: string) => relay.hosts.find((host) => host.id === id)
  const route = async (method: string, path: string, init: RequestInit): Promise<Response> => {
    if (method === "GET" && path === "/v1/account") return Response.json(relay.profile)
    if (method === "DELETE" && path === "/v1/device") return new Response(null, { status: 204 })
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
    credential: CREDENTIAL,
    issuedCredential: CREDENTIAL,
    challenges: new Map(),
    profile: { name: "Kalan", email: "kalan@example.com" },
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
      if (method === "POST" && url.pathname === "/v1/sign-in-codes/exchange") {
        const { code, codeVerifier } = JSON.parse(String(init.body)) as { code: string; codeVerifier: string }
        const challenge = relay.challenges.get(code)
        relay.challenges.delete(code)
        if (challenge !== createHash("sha256").update(codeVerifier).digest("base64url")) {
          return Response.json({ error: "That sign-in expired." }, { status: 410 })
        }
        return Response.json({ credential: relay.issuedCredential })
      }
      if (new Headers(init.headers).get("Authorization") !== `Bearer ${relay.credential}`) {
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
    | Settings.Settings
  >,
) =>
  effect.pipe(
    Effect.provide(
      RelayAccount.layer({ serviceUrl: SERVICE_URL, fetch: relay.fetch }).pipe(
        Layer.provideMerge(Environments.layer),
        Layer.provideMerge(RemoteAccess.layer),
        Layer.provideMerge(Secrets.layer),
        Layer.provideMerge(Settings.layer(mkdtempSync(join(tmpdir(), "kk-relay-account-")))),
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
const signInPage = (url: string) => {
  const page = new URL(url)
  expect(`${page.origin}${page.pathname}`).toBe(`${SERVICE_URL}/sign-in`)
  const redirectUri = page.searchParams.get("redirect_uri") ?? ""
  expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  return {
    redirectUri,
    codeChallenge: page.searchParams.get("code_challenge") ?? "",
    name: page.searchParams.get("name"),
  }
}

const visit = (url: string) =>
  Effect.promise(() =>
    fetch(url, { redirect: "manual" }).then(
      (answer) => ({ status: answer.status, location: answer.headers.get("location") }),
      () => "refused" as const,
    ),
  )

const rawStatus = (port: string, path: string) =>
  Effect.callback<number | undefined>((resume) => {
    request({ host: "127.0.0.1", port, path }, (response) => {
      response.resume()
      resume(Effect.succeed(response.statusCode))
    })
      .on("error", () => resume(Effect.succeed(undefined)))
      .end()
  })

const approveInBrowser = (relay: StandInRelay) => (url: string) =>
  Effect.gen(function* () {
    const { redirectUri, codeChallenge } = signInPage(url)
    relay.challenges.set(SIGN_IN_CODE, codeChallenge)
    expect(yield* visit(`${redirectUri}?code=${SIGN_IN_CODE}`)).toStrictEqual({
      status: 302,
      location: `${SERVICE_URL}/signed-in`,
    })
  })

const signInWith = (openUrl: (url: string) => Effect.Effect<void>) =>
  account.use((relayAccount) => relayAccount.signIn({ openUrl }))

const signIn = (relay: StandInRelay) => signInWith(approveInBrowser(relay))

const openedPages = () => {
  const pages: Array<string> = []
  return {
    pages,
    openUrl: (url: string) => Effect.sync(() => void pages.push(url)),
    opened: Effect.yieldNow.pipe(
      Effect.repeat({ until: () => pages.length > 0 }),
      Effect.map(() => signInPage(pages[0] ?? "")),
    ),
  }
}
const storedCredential = Secrets.Secrets.use((secrets) => secrets.get("relay.deviceCredential")).pipe(
  Effect.map(Option.getOrNull),
)

describe("RelayAccount", () => {
  it.live("signing in follows the browser back to this app and adds every machine the relay lists", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const opened: Array<string> = []
        const status = yield* signInWith((url) =>
          Effect.andThen(
            Effect.sync(() => void opened.push(url)),
            approveInBrowser(relay)(url),
          ),
        )

        const self = (yield* RemoteAccess.RemoteAccess).identity
        expect(opened.map((url) => signInPage(url).name)).toStrictEqual([self.name])
        expect(status).toStrictEqual({
          state: "signedIn",
          serviceUrl: SERVICE_URL,
          environmentId: self.id,
          name: "Kalan",
          email: "kalan@example.com",
          machines: 1,
          syncedAt: expect.any(String),
          error: null,
        })
        expect(yield* storedCredential).toBe(CREDENTIAL)
        expect(yield* listed).toStrictEqual([{ id: "home-server", source: "relay" }])
      }),
    )
  })

  it.live("a first sync that fails keeps the issued credential and says why", () => {
    const relay = standInRelay()
    relay.issuedCredential = "stale"
    return withAccount(
      relay,
      Effect.gen(function* () {
        const status = yield* signIn(relay)

        expect(status).toMatchObject({ state: "signedIn", error: expect.stringMatching(/no longer accepts/) })
        expect(yield* storedCredential).toBe("stale")
      }),
    )
  })

  it.live("the listener refuses other paths and callbacks without a code, and keeps waiting", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const browser = openedPages()
        const signingIn = yield* signInWith(browser.openUrl).pipe(Effect.forkChild)
        const { redirectUri } = yield* browser.opened

        expect(yield* visit(redirectUri.replace("/callback", "/other?code=x"))).toMatchObject({ status: 404 })
        expect(yield* visit(redirectUri)).toMatchObject({ status: 404 })
        expect(yield* visit(`${redirectUri}?code=`)).toMatchObject({ status: 404 })
        expect(signingIn.pollUnsafe()).toBeUndefined()

        yield* approveInBrowser(relay)(browser.pages[0] ?? "")
        expect(yield* Fiber.join(signingIn)).toMatchObject({ state: "signedIn" })
        expect(yield* storedCredential).toBe(CREDENTIAL)
      }),
    )
  })

  it.live("a request line the listener cannot parse gets 400 and the sign-in keeps waiting", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const browser = openedPages()
        const signingIn = yield* signInWith(browser.openUrl).pipe(Effect.forkChild)
        const { redirectUri } = yield* browser.opened

        expect(yield* rawStatus(new URL(redirectUri).port, "//[")).toBe(400)
        expect(signingIn.pollUnsafe()).toBeUndefined()

        yield* approveInBrowser(relay)(browser.pages[0] ?? "")
        expect(yield* Fiber.join(signingIn)).toMatchObject({ state: "signedIn" })
      }),
    )
  })

  it.live("logging out while the browser is open ends the sign-in and closes the listener", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const browser = openedPages()
        const signingIn = yield* signInWith(browser.openUrl).pipe(Effect.forkChild)
        const { redirectUri } = yield* browser.opened

        yield* account.use((relayAccount) => relayAccount.signOut)

        expect(yield* Fiber.join(signingIn)).toStrictEqual({ state: "signedOut" })
        expect(yield* visit(`${redirectUri}?code=${SIGN_IN_CODE}`)).toBe("refused")
        expect(yield* storedCredential).toBeNull()
        expect(relay.calls).not.toContain("POST /v1/sign-in-codes/exchange")
      }),
    )
  })

  it.effect("a sign-in nobody finishes in ten minutes keeps nothing and says so", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const browser = openedPages()
        const signingIn = yield* signInWith(browser.openUrl).pipe(Effect.forkChild)
        const { redirectUri } = yield* browser.opened

        yield* TestClock.adjust(Duration.minutes(10))

        expect((yield* Effect.flip(Fiber.join(signingIn))).message).toMatch(/expired/)
        expect(yield* visit(`${redirectUri}?code=${SIGN_IN_CODE}`)).toBe("refused")
        expect(yield* storedCredential).toBeNull()
      }),
    )
  })

  it.live("a code the relay will not exchange keeps nothing and says to sign in again", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          signInWith((url) =>
            Effect.andThen(
              approveInBrowser(relay)(url),
              Effect.sync(() => relay.challenges.clear()),
            ),
          ),
        )

        expect(error.message).toBe("The sign-in expired or was already used. Sign in again.")
        expect(yield* storedCredential).toBeNull()
      }),
    )
  })

  it.live("a second sign-in replaces the first, which ends signed out", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const browser = openedPages()
        const first = yield* signInWith(browser.openUrl).pipe(Effect.forkChild)
        const { redirectUri } = yield* browser.opened

        const second = yield* signIn(relay)
        expect(second).toMatchObject({ state: "signedIn" })
        expect(yield* Fiber.join(first)).toMatchObject({ state: "signedOut" })
        expect(yield* visit(`${redirectUri}?code=${SIGN_IN_CODE}`)).toBe("refused")
      }),
    )
  })

  it.live("a profile the relay cannot read does not fail the sign-in", () => {
    const relay = standInRelay()
    relay.profile = "broken" as never
    return withAccount(
      relay,
      Effect.gen(function* () {
        expect(yield* signIn(relay)).toMatchObject({ state: "signedIn", name: null, email: null, machines: 1 })
      }),
    )
  })

  it.live("a refused credential at sync keeps every machine and says why", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* signIn(relay)
        relay.credential = "rotated"
        relay.machines = []

        const status = yield* account.use((relayAccount) => relayAccount.sync)

        expect(status).toMatchObject({
          state: "signedIn",
          machines: 1,
          error: expect.stringMatching(/no longer accepts/),
        })
        expect(yield* listed).toStrictEqual([{ id: "home-server", source: "relay" }])
      }),
    )
  })

  it.live("signing out drops the relay's machines and forgets the credential", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* signIn(relay)

        expect(yield* account.use((relayAccount) => relayAccount.signOut)).toStrictEqual({ state: "signedOut" })
        expect(relay.calls).toContain("DELETE /v1/device")
        expect(yield* storedCredential).toBeNull()
        expect(yield* listed).toStrictEqual([])
      }),
    )
  })

  it.live("lists every machine linked to the relay", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* signIn(relay)

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

        expect(error.message).toBe("Sign in to the relay in Settings > Connections first.")
        expect(relay.calls).toStrictEqual([])
      }),
    )
  })

  it.live("hiding a machine drops its environment at once and answers the fresh list", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* signIn(relay)

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
        yield* signIn(relay)

        const hosts = yield* account.use((relayAccount) => relayAccount.removeMachine({ id: "host-1" }))

        expect(relay.calls).toContain("DELETE /v1/hosts/host-1")
        expect(hosts).toStrictEqual([])
        expect(yield* listed).toStrictEqual([])
      }),
    )
  })

  it.live("removing this desktop from here is refused and points to Settings > Connections", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        const self = (yield* RemoteAccess.RemoteAccess).identity
        relay.hosts = [...relay.hosts, { ...homeServerHost, id: "host-self", environmentId: self.id, name: self.name }]
        yield* signIn(relay)

        const error = yield* account
          .use((relayAccount) => relayAccount.removeMachine({ id: "host-self" }))
          .pipe(Effect.flip)

        expect(error.message).toBe("To unlink this machine, sign out.")
        expect(relay.calls).not.toContain("DELETE /v1/hosts/host-self")
        expect(relay.hosts.map((host) => host.id)).toStrictEqual(["host-1", "host-self"])
      }),
    )
  })

  it.live("approves this desktop's own link while signed in", () => {
    const relay = standInRelay()
    relay.links.set("SELF-CODE", { name: "this-desktop", environmentId: "this-desktop" })
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* signIn(relay)

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

  it.live("a refused credential on any machine call says to sign in again", () => {
    const relay = standInRelay()
    return withAccount(
      relay,
      Effect.gen(function* () {
        yield* signIn(relay)
        relay.credential = "rotated"

        const calls: Array<Effect.Effect<unknown, { readonly message: string }, RelayAccount.RelayAccount>> = [
          account.use((relayAccount) => relayAccount.machines),
          account.use((relayAccount) => relayAccount.setShown({ id: "host-1", enabled: false })),
          account.use((relayAccount) => relayAccount.removeMachine({ id: "host-1" })),
        ]
        for (const call of calls) {
          expect((yield* Effect.flip(call)).message).toMatch(/no longer accepts this device/)
        }
        expect(yield* account.use((relayAccount) => relayAccount.approveOwnLink("ABCD-EFGH"))).toBe(false)
        expect(relay.approved).toStrictEqual([])
      }),
    )
  })
})
