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
  approvalCode: null,
  connections: [],
}
const claude = { id: "connection-1", name: "Claude", createdAt: "2026-11-10T00:00:00.000Z", lastUsedAt: null }

let status: AppConnectionsStatus = linked
let removed: Array<string> = []
let pushListeners: Array<Parameters<HinacodeBridge["onEvent"]>[0]> = []

const change = (next: AppConnectionsStatus) => {
  status = next
  for (const listener of pushListeners) listener({ type: "appConnections.changed", status })
  return { result: status }
}

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "appConnections.status") return { result: status }
    if (method === "appConnections.newApprovalCode")
      return change({ ...status, approvalCode: { code: "ABCD2345", expiresAt: "2026-11-10T00:10:00.000Z" } })
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

beforeEach(() => {
  status = linked
  removed = []
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
  expect(page.getByRole("button", { name: "New code" }).query()).toBeNull()
})

test("shows the address and a new approval code", async () => {
  await renderSettings()
  await expect.element(page.getByText("https://0123456789abcdef.hinacode.app/mcp")).toBeVisible()
  expect(page.getByText("Approval code").query()).toBeNull()
  await page.getByRole("button", { name: "New code" }).click()
  await expect.element(page.getByText("ABCD2345")).toBeVisible()
})

test("lists an app once it connects and removes it", async () => {
  await renderSettings()
  await expect.element(page.getByRole("button", { name: "New code" })).toBeVisible()
  change({ ...linked, connections: [claude] })
  await expect.element(page.getByText("Claude", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Remove Claude" }).click()
  await expect.poll(() => removed).toEqual(["connection-1"])
  await expect.poll(() => page.getByText("Claude", { exact: true }).query()).toBeNull()
})
