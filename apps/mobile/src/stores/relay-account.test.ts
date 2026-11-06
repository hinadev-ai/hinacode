import type { EntrySource } from "@shared/relayMachines.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { create } from "zustand"
import type { ConnectionStatus, Server } from "@/lib/connection"
import { pkcePair, signInUrl } from "@/lib/relay-account"
import type { StoredServer } from "@/lib/stored-target"

const connection = vi.hoisted(() => ({ store: null as unknown }))
const saved = vi.hoisted((): unknown[] => [])
vi.mock("@/lib/connection", () => {
  const useConnection = create<{ servers: readonly Server[] }>()(() => ({ servers: [] }))
  connection.store = useConnection
  return {
    useConnection,
    storedServers: () => useConnection.getState().servers,
    setServers: (servers: readonly StoredServer[]) =>
      useConnection.setState({ servers: servers.map((server) => ({ ...server, status: "connecting" }) as Server) }),
  }
})
vi.mock("@/lib/storage", () => ({
  loadRelayAccount: async () => null,
  saveRelayAccount: async (account: unknown) => void saved.push(account),
  clearRelayAccount: async () => {},
}))
vi.mock("@/stores/threads", () => ({ useThreads: { getState: () => ({ load: async () => {} }) } }))
vi.mock("@/stores/pull-requests", () => ({ usePullRequests: { getState: () => ({ load: async () => {} }) } }))
vi.mock("react-native", () => ({ AppState: { currentState: "active" } }))

const { useRelayAccount } = await import("./relay-account")
const useConnection = connection.store as typeof import("@/lib/connection").useConnection

const serviceUrl = "https://relay.example.com"
const callback = "hinacode://signed-in?code=abc"
const random = new Uint8Array(32).fill(7)
const signInWith = (authenticate: (url: string, redirectUri: string) => Promise<string | null>) =>
  useRelayAccount.getState().signIn({ serviceUrl, deviceName: "iPhone", random, authenticate })

let token: string
let syncs: number
let exchanged: unknown[]

const machine = () => ({
  environmentId: "env-a",
  name: "Studio",
  pairing: { hosts: ["192.168.1.5"], port: 47821, token, relay: "studio.relay.example.com" },
})

const setStatus = (status: ConnectionStatus, source: EntrySource = "relay") =>
  useConnection.setState((state) => ({
    servers: state.servers.map((server) => ({ ...server, status, source })),
  }))

const relay = (machines: () => Response) => async (url: string, init?: RequestInit) => {
  if (url.endsWith("/v1/sign-in-codes/exchange")) {
    exchanged.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ credential: "device" }), { status: 200 })
  }
  if (url.endsWith("/v1/device")) return new Response(null, { status: 204 })
  syncs++
  return machines()
}

beforeEach(async () => {
  vi.useFakeTimers()
  token = "first"
  syncs = 0
  exchanged = []
  saved.length = 0
  vi.stubGlobal("fetch", relay(() => new Response(JSON.stringify({ machines: [machine()] }), { status: 200 })))
})

afterEach(async () => {
  await useRelayAccount.getState().signOut()
  useConnection.setState({ servers: [] })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it("signs in through the redirect, saves the account and syncs", async () => {
  const opened: { url: string; redirectUri: string }[] = []
  expect(
    await signInWith(async (url, redirectUri) => {
      opened.push({ url, redirectUri })
      return callback
    }),
  ).toBeNull()

  const { verifier, challenge } = pkcePair(random)
  expect(opened).toEqual([
    { url: signInUrl(serviceUrl, { redirectUri: "hinacode://signed-in", challenge, name: "iPhone" }), redirectUri: "hinacode://signed-in" },
  ])
  expect(exchanged).toEqual([{ code: "abc", codeVerifier: verifier }])
  expect(saved).toEqual([{ serviceUrl, credential: "device" }])
  expect(syncs).toBe(1)
  expect(useRelayAccount.getState()).toMatchObject({ serviceUrl, machines: 1, error: null })
})

it("stays signed out without an error when the person closes the sign-in", async () => {
  expect(await signInWith(async () => null)).toBeNull()
  expect(exchanged).toEqual([])
  expect(saved).toEqual([])
  expect(useRelayAccount.getState().serviceUrl).toBeNull()
})

it("keeps the credential when the first sync fails, and says why", async () => {
  vi.stubGlobal("fetch", relay(() => new Response(null, { status: 503 })))
  await signInWith(async () => callback)
  expect(saved).toEqual([{ serviceUrl, credential: "device" }])
  expect(useRelayAccount.getState().serviceUrl).toBe(serviceUrl)
  expect(useRelayAccount.getState().error).not.toBeNull()
})

it("discards the redirect when logout happens while the sign-in is open", async () => {
  let redirect = (_: string | null) => {}
  const signingIn = signInWith(() => new Promise((resolve) => (redirect = resolve)))

  await useRelayAccount.getState().signOut()
  redirect(callback)

  expect(await signingIn).toBeNull()
  expect(exchanged).toEqual([])
  expect(saved).toEqual([])
  expect(useRelayAccount.getState().serviceUrl).toBeNull()
})

it("revokes the credential and stays signed out when logout beats the exchange", async () => {
  let answer = (_: Response) => {}
  const revoked: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/v1/sign-in-codes/exchange")) return new Promise<Response>((resolve) => (answer = resolve))
    if (url.endsWith("/v1/device")) {
      revoked.push(url)
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ machines: [machine()] }), { status: 200 })
  })
  const signingIn = signInWith(async () => callback)
  await vi.advanceTimersByTimeAsync(0)

  await useRelayAccount.getState().signOut()
  answer(new Response(JSON.stringify({ credential: "device" }), { status: 200 }))
  await signingIn

  expect(useRelayAccount.getState().serviceUrl).toBeNull()
  expect(saved).toEqual([])
  expect(revoked).toHaveLength(1)
})

describe("while signed in", () => {
  beforeEach(async () => {
    await signInWith(async () => callback)
    syncs = 0
  })

  it("syncs while a relay server refuses its token, until the sync brings a new one", async () => {
    setStatus("unauthorized")
    await vi.advanceTimersByTimeAsync(0)
    expect(syncs).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(syncs).toBe(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(syncs).toBe(3)

    token = "rotated"
    await vi.advanceTimersByTimeAsync(15_000)
    expect(syncs).toBe(4)
    expect(useConnection.getState().servers[0]).toMatchObject({ token: "rotated", status: "connecting" })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(syncs).toBe(4)
  })

  it("does not sync for a QR-paired server that refuses its token", async () => {
    setStatus("unauthorized", "pairing")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(syncs).toBe(0)
  })
})
