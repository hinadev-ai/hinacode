import type { EntrySource } from "@shared/relayMachines.ts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { create } from "zustand"
import type { ConnectionStatus, Server } from "@/lib/connection"
import type { StoredServer } from "@/lib/stored-target"

const connection = vi.hoisted(() => ({ store: null as unknown }))
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
  saveRelayAccount: async () => {},
  clearRelayAccount: async () => {},
  loadPreferences: async () => ({}),
  savePreferences: async () => {},
}))
const push = vi.hoisted(() => ({ token: null as string | null }))
vi.mock("@/lib/notifications", () => ({ getPushToken: async () => push.token }))
vi.mock("expo-constants", () => ({ default: { expoConfig: null } }))
vi.mock("@/stores/threads", () => ({ useThreads: { getState: () => ({ load: async () => {} }) } }))
vi.mock("@/stores/pull-requests", () => ({ usePullRequests: { getState: () => ({ load: async () => {} }) } }))
vi.mock("react-native", () => ({ AppState: { currentState: "active" } }))

const { pushRegistered, useRelayAccount } = await import("./relay-account")
const { usePreferences } = await import("./preferences")
const useConnection = connection.store as typeof import("@/lib/connection").useConnection

let token: string
let syncs: number
let devices: { method: string | undefined; body: unknown }[]
let devicesStatus: number

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
  devices = []
  devicesStatus = 204
  push.token = null
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/devices")) {
      devices.push({ method: init?.method, body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: devicesStatus })
    }
    syncs++
    return new Response(JSON.stringify({ machines: [machine()] }), { status: 200 })
  })
  await useRelayAccount.getState().signIn({ serviceUrl: "https://relay.example.com", ownerToken: "owner" })
  syncs = 0
})

afterEach(async () => {
  await useRelayAccount.getState().signOut()
  useConnection.setState({ servers: [] })
  usePreferences.setState({ notifications: { completed: true, needsInput: true, failed: true } })
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

it("registers for push at sign-in, each sync and each preference change, and unregisters at sign-out", async () => {
  await useRelayAccount.getState().signOut()
  push.token = "ExponentPushToken[abc]"
  devices = []
  await useRelayAccount.getState().signIn({ serviceUrl: "https://relay.example.com", ownerToken: "owner" })
  await vi.advanceTimersByTimeAsync(0)
  expect(pushRegistered()).toBe(true)
  await useRelayAccount.getState().sync()
  await vi.advanceTimersByTimeAsync(0)
  usePreferences.setState({ notifications: { completed: false, needsInput: true, failed: true } })
  await vi.advanceTimersByTimeAsync(0)
  await useRelayAccount.getState().signOut()

  const all = ["completed", "needsInput", "failed"]
  expect(devices).toEqual([
    { method: "PUT", body: { token: push.token, alerts: all } },
    { method: "PUT", body: { token: push.token, alerts: all } },
    { method: "PUT", body: { token: push.token, alerts: ["needsInput", "failed"] } },
    { method: "DELETE", body: { token: push.token } },
  ])
  expect(pushRegistered()).toBe(false)
})

it("signs in without push when the relay refuses the device or no token exists", async () => {
  await useRelayAccount.getState().signOut()
  push.token = "ExponentPushToken[abc]"
  devicesStatus = 404
  expect(
    await useRelayAccount.getState().signIn({ serviceUrl: "https://relay.example.com", ownerToken: "owner" }),
  ).toBe(null)
  await vi.advanceTimersByTimeAsync(0)
  expect(pushRegistered()).toBe(false)

  await useRelayAccount.getState().signOut()
  push.token = null
  devices = []
  await useRelayAccount.getState().signIn({ serviceUrl: "https://relay.example.com", ownerToken: "owner" })
  await vi.advanceTimersByTimeAsync(0)
  expect(devices).toEqual([])
  expect(pushRegistered()).toBe(false)
})
