import { RegistryProvider } from "@effect/atom-react"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import type { AppConnectionsStatus } from "../../../shared/domain.ts"
import "../../index.css"
import { AppConnectionsSettings } from "./AppConnectionsSettings.tsx"

const linked: AppConnectionsStatus = {
  url: "https://0123456789abcdef.hinacode.app/mcp",
  waitingUntil: null,
  requests: [],
  connections: [],
}
const grokRequest = { id: "request-1", name: "Grok Bot", redirectHost: "grok.example" }
const claude = { id: "connection-1", name: "Claude", createdAt: "2026-11-10T00:00:00.000Z", lastUsedAt: null }

let status: AppConnectionsStatus = linked
let removed: Array<string> = []
let answers: Array<{ id: string; approve: boolean }> = []
let copied: Array<string> = []
let opened: Array<string> = []
let pushListeners: Array<Parameters<HinacodeBridge["onEvent"]>[0]> = []

const change = (next: AppConnectionsStatus) => {
  status = next
  for (const listener of pushListeners) listener({ type: "appConnections.changed", status })
  return { result: status }
}

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "appConnections.status") return { result: status }
    if (method === "appConnections.start") return change({ ...status, waitingUntil: "2026-11-10T00:10:00.000Z" })
    if (method === "appConnections.answer") {
      answers.push(payload as { id: string; approve: boolean })
      return change({ ...status, waitingUntil: null, requests: [] })
    }
    if (method === "appConnections.remove") {
      const { id } = payload as { id: string }
      removed.push(id)
      return change({ ...status, connections: status.connections.filter((connection) => connection.id !== id) })
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: (listener) => {
    pushListeners.push(listener)
    return () => {
      pushListeners = pushListeners.filter((other) => other !== listener)
    }
  },
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void copied.push(text) },
})
window.open = (url) => {
  opened.push(String(url))
  return null
}

beforeEach(() => {
  status = linked
  removed = []
  answers = []
  copied = []
  opened = []
})

const renderSettings = () =>
  render(
    <RegistryProvider>
      <AppConnectionsSettings />
    </RegistryProvider>,
  )

test("asks for the relay when this machine has no address", async () => {
  status = { ...linked, url: null }
  await renderSettings()
  await expect.element(page.getByText("Sign in to the relay to connect apps.")).toBeVisible()
  expect(page.getByRole("button", { name: "Grok Bot" }).query()).toBeNull()
})

test("choosing Grok Bot copies the URL, opens Grok and waits for its sign-in", async () => {
  await renderSettings()
  await page.getByRole("button", { name: "Grok Bot" }).click()
  await expect.element(page.getByText("Waiting for the app to sign in.")).toBeVisible()
  expect(copied).toEqual([linked.url])
  expect(opened).toEqual(["https://x.ai/bot"])
})

test("choosing Claude opens its connector form with the URL filled in", async () => {
  await renderSettings()
  await page.getByRole("button", { name: "Claude" }).click()
  await expect.poll(() => opened).toHaveLength(1)
  const form = new URL(opened[0]!)
  expect(form.searchParams.get("connectorUrl")).toBe(linked.url)
  expect(copied).toEqual([])
})

test("approves an app that asks to connect", async () => {
  status = { ...linked, waitingUntil: "2026-11-10T00:10:00.000Z", requests: [grokRequest] }
  await renderSettings()
  await expect.element(page.getByText("Grok Bot wants to connect")).toBeVisible()
  await expect.element(page.getByText("Returns to grok.example")).toBeVisible()
  expect(page.getByText("Waiting for the app to sign in.").query()).toBeNull()
  await page.getByRole("button", { name: "Approve" }).click()
  await expect.poll(() => answers).toEqual([{ id: "request-1", approve: true }])
  await expect.poll(() => page.getByText("Grok Bot wants to connect").query()).toBeNull()
})

test("lists an app once it connects and removes it", async () => {
  await renderSettings()
  await expect.element(page.getByRole("button", { name: "Grok Bot" })).toBeVisible()
  change({ ...linked, connections: [claude] })
  await expect.element(page.getByTitle("Claude", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Remove Claude" }).click()
  await expect.poll(() => removed).toEqual(["connection-1"])
  await expect.poll(() => page.getByTitle("Claude", { exact: true }).query()).toBeNull()
})

test("an app stays removable after the relay is gone", async () => {
  status = { ...linked, url: null, connections: [claude] }
  await renderSettings()
  await page.getByRole("button", { name: "Remove Claude" }).click()
  await expect.poll(() => removed).toEqual(["connection-1"])
})
