import { describe, expect, it, vi } from "vitest"
import type { ConnectionStatus } from "@/lib/connection"

vi.mock("expo-constants", () => ({ default: { expoConfig: null } }))

const { alertsOf, registerDevice, shouldPresentLocal, shouldShowPush, unregisterDevice } = await import("./push")

const account = { serviceUrl: "https://relay.example.com/", ownerToken: "owner" }
const token = "ExponentPushToken[abc]"
const server = (environmentId: string | null, status: ConnectionStatus) => ({ environmentId, status })

describe("shouldShowPush", () => {
  it("drops a push from a machine the phone is connected to, since its banner already showed", () => {
    expect(shouldShowPush({ threadId: "t", environmentId: "env-a" }, [server("env-a", "connected")])).toBe(false)
  })

  it("shows a push from a machine whose socket is not open", () => {
    const servers = [server("env-a", "connecting"), server("env-b", "offline"), server("env-c", "connected")]
    expect(shouldShowPush({ threadId: "t", environmentId: "env-a" }, servers)).toBe(true)
    expect(shouldShowPush({ threadId: "t", environmentId: "env-b" }, servers)).toBe(true)
  })

  it("shows a push from a machine the phone never paired with", () => {
    expect(shouldShowPush({ threadId: "t", environmentId: "env-z" }, [server("env-a", "connected")])).toBe(true)
  })

  it("shows a push whose data it cannot read", () => {
    const servers = [server("env-a", "connected"), server(null, "connected")]
    for (const data of [null, undefined, "env-a", {}, { environmentId: 7 }, { environmentId: null }])
      expect(shouldShowPush(data, servers)).toBe(true)
  })
})

describe("shouldPresentLocal", () => {
  it("leaves the notice to the push when this phone registered and the machine has a relay", () => {
    expect(shouldPresentLocal({ pushRegistered: true, server: { relay: "studio.relay.example.com" } })).toBe(false)
  })

  it("notifies locally when no push will come", () => {
    expect(shouldPresentLocal({ pushRegistered: false, server: { relay: "studio.relay.example.com" } })).toBe(true)
    expect(shouldPresentLocal({ pushRegistered: true, server: { relay: null } })).toBe(true)
    expect(shouldPresentLocal({ pushRegistered: true, server: undefined })).toBe(true)
  })
})

it("registers only the kinds the phone keeps on", () => {
  expect(alertsOf({ completed: true, needsInput: false, failed: true })).toEqual(["completed", "failed"])
})

describe("registerDevice and unregisterDevice", () => {
  const recording = (response: () => Promise<Response>) => {
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return response()
    }
    return { requests, fetch: fetch as typeof globalThis.fetch }
  }

  it("sends the token and alerts with the owner token", async () => {
    const { requests, fetch } = recording(async () => new Response(null, { status: 204 }))
    expect(await registerDevice(account, token, ["completed", "needsInput"], fetch)).toBe(true)
    expect(await unregisterDevice(account, token, fetch)).toBe(true)
    expect(requests.map(({ url, init }) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
      ["https://relay.example.com/v1/devices", "PUT", { token, alerts: ["completed", "needsInput"] }],
      ["https://relay.example.com/v1/devices", "DELETE", { token }],
    ])
    for (const { init } of requests) expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer owner")
  })

  it("reports a refusal or an unreachable relay instead of throwing", async () => {
    const refused = recording(async () => new Response(null, { status: 401 }))
    expect(await registerDevice(account, token, [], refused.fetch)).toBe(false)
    const offline = recording(async () => {
      throw new TypeError("Network request failed")
    })
    expect(await registerDevice(account, token, [], offline.fetch)).toBe(false)
    expect(await unregisterDevice(account, token, offline.fetch)).toBe(false)
  })
})
