import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Clerk } from "./clerk.ts"

const clerk = vi.hoisted(() => ({
  isSignedIn: true,
  session: { getToken: async () => "session-token" },
  load: async () => undefined,
  mountSignIn: () => undefined,
  unmountSignIn: () => undefined,
  signOut: async () => undefined,
}))

vi.mock("./clerk.ts", () => ({ loadClerk: async (): Promise<Clerk> => clerk }))

const { openSignIn, signOutDevice, storedAccount } = await import("./account.ts")

const serviceUrl = "https://relay.test"

const memoryStorage = (): Storage => {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

const relay = () => {
  const requests: Array<string> = []
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  const fetch = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    requests.push(`${init?.method ?? "GET"} ${path}`)
    if (path === "/v1/config") return json({ clerkPublishableKey: "pk_test_key" })
    if (path === "/v1/device") return new Response(null, { status: 204 })
    if (path === "/v1/devices") return json({ credential: "new-credential" })
    return json({ machines: [] })
  }
  return { requests, fetch }
}

describe("signOutDevice", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage())
    clerk.isSignedIn = true
  })
  afterEach(() => vi.unstubAllGlobals())

  it("does not create a new device on the next load when Clerk keeps its session", async () => {
    const server = relay()
    vi.stubGlobal("fetch", server.fetch)
    clerk.signOut = () => Promise.reject(new Error("Clerk is unavailable"))

    await signOutDevice({ serviceUrl, credential: "old-credential" })
    const step = await openSignIn(serviceUrl, () => undefined).step

    expect(step._tag).not.toBe("signingIn")
    expect(server.requests).not.toContain("POST /v1/devices")
    expect(storedAccount()).toBeNull()
  })
})
