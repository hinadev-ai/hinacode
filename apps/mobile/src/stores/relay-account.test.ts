import type { EntrySource } from "@shared/relayMachines.ts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { create } from "zustand"
import type { ConnectionStatus, Server } from "@/lib/connection"
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

const signInAnswer = { deviceCode: "code", url: "https://relay.example.com/link", interval: 0, expiresAt: 4_000_000_000_000 }
const signInInput = { serviceUrl: "https://relay.example.com", deviceName: "iPhone", openUrl: async () => {} }

let token: string
let syncs: number

const machine = () => ({
  environmentId: "env-a",
  name: "Studio",
  pairing: { hosts: ["192.168.1.5"], port: 47821, token, relay: "studio.relay.example.com" },
})

const setStatus = (status: ConnectionStatus, source: EntrySource = "relay") =>
  useConnection.setState((state) => ({
    servers: state.servers.map((server) => ({ ...server, status, source })),
  }))

beforeEach(async () => {
  vi.useFakeTimers()
  token = "first"
  syncs = 0
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/v1/sign-ins")) {
      const signIn = { deviceCode: "code", url: "https://relay.example.com/link", interval: 0, expiresAt: 4_000_000_000_000 }
      return new Response(JSON.stringify(signIn), { status: 200 })
    }
    if (url.endsWith("/v1/links/claim")) return new Response(JSON.stringify({ credential: "device" }), { status: 200 })
    if (url.endsWith("/v1/device")) return new Response(null, { status: 204 })
    syncs++
    return new Response(JSON.stringify({ machines: [machine()] }), { status: 200 })
  })
  const opened: string[] = []
  const signingIn = useRelayAccount.getState().signIn({
    serviceUrl: "https://relay.example.com",
    deviceName: "iPhone",
    openUrl: async (url) => opened.push(url),
  })
  await vi.advanceTimersByTimeAsync(1)
  expect(await signingIn).toBeNull()
  expect(opened).toEqual(["https://relay.example.com/link"])
  syncs = 0
})

afterEach(async () => {
  await useRelayAccount.getState().signOut()
  useConnection.setState({ servers: [] })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it("keeps the credential when the first sync fails, and says why", async () => {
  await useRelayAccount.getState().signOut()
  saved.length = 0
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/v1/sign-ins")) return new Response(JSON.stringify(signInAnswer), { status: 200 })
    if (url.endsWith("/v1/links/claim")) return new Response(JSON.stringify({ credential: "device" }), { status: 200 })
    return new Response(null, { status: 503 })
  })
  const signingIn = useRelayAccount.getState().signIn(signInInput)
  await vi.advanceTimersByTimeAsync(1)
  await signingIn
  expect(saved).toEqual([{ serviceUrl: "https://relay.example.com", credential: "device" }])
  expect(useRelayAccount.getState().serviceUrl).toBe("https://relay.example.com")
  expect(useRelayAccount.getState().error).not.toBeNull()
})

it("revokes the credential and stays signed out when logout beats the claim", async () => {
  await useRelayAccount.getState().signOut()
  saved.length = 0
  let approve = (_: Response) => {}
  const revoked: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/v1/sign-ins")) return new Response(JSON.stringify(signInAnswer), { status: 200 })
    if (url.endsWith("/v1/links/claim")) return new Promise<Response>((resolve) => (approve = resolve))
    if (url.endsWith("/v1/device")) {
      revoked.push(url)
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ machines: [machine()] }), { status: 200 })
  })
  const signingIn = useRelayAccount.getState().signIn(signInInput)
  await vi.advanceTimersByTimeAsync(1)

  await useRelayAccount.getState().signOut()
  approve(new Response(JSON.stringify({ credential: "device" }), { status: 200 }))
  await signingIn

  expect(useRelayAccount.getState().serviceUrl).toBeNull()
  expect(saved).toEqual([])
  expect(revoked).toHaveLength(1)
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
