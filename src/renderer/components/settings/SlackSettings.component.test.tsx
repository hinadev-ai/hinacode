import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import type { SlackStatus, SlackTokens } from "../../../shared/domain.ts"
import "../../index.css"
import { SlackSettings } from "./SlackSettings.tsx"

const disconnected: SlackStatus = { type: "disconnected" }
const rejected: SlackStatus = { type: "failed", reason: "invalid_auth" }
const connected: SlackStatus = { type: "connected", team: "Acme", botUser: "hina" }

let status: SlackStatus = disconnected
let afterConnect: SlackStatus = connected
let connectRefusal: string | null = null
let calls: Array<string> = []
let connects: Array<SlackTokens> = []
let pushListeners: Array<Parameters<HinacodeBridge["onEvent"]>[0]> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    calls.push(method)
    if (method === "slack.status") return { result: status }
    if (method === "slack.connect") {
      if (connectRefusal !== null) return { error: { tag: "SecretsError", message: connectRefusal } }
      connects.push(payload as SlackTokens)
      status = afterConnect
      return { result: status }
    }
    if (method === "slack.disconnect") {
      status = disconnected
      return { result: status }
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
  status = disconnected
  afterConnect = connected
  connectRefusal = null
  calls = []
  connects = []
})

const renderSettings = async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <RegistryProvider>
        <SlackSettings />
      </RegistryProvider>
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await router.load()
  return render(<RouterProvider router={router} />)
}

const appToken = () => page.getByLabelText("App token")
const botToken = () => page.getByLabelText("Bot token")
const connect = () => page.getByRole("button", { name: "Connect", exact: true })
const disconnect = () => page.getByRole("button", { name: "Disconnect" })

test("connects once both tokens have their prefix, then shows the workspace", async () => {
  await renderSettings()
  await expect.element(page.getByText("Not connected")).toBeVisible()
  await expect.element(page.getByRole("link", { name: "Create Slack app" })).toHaveAttribute("target", "_blank")
  expect(disconnect().query()).toBeNull()
  await expect.element(connect()).toBeDisabled()

  await appToken().fill("  xapp-1-abc ")
  await expect.element(connect()).toBeDisabled()
  await botToken().fill("xapp-1-abc")
  await expect.element(connect()).toBeDisabled()
  await botToken().fill(" xoxb-2-def  ")
  await expect.element(connect()).toBeEnabled()
  await appToken().fill("xoxb-2-def")
  await expect.element(connect()).toBeDisabled()
  await appToken().fill("  xapp-1-abc ")

  await connect().click()
  await expect.poll(() => connects).toEqual([{ appToken: "xapp-1-abc", botToken: "xoxb-2-def" }])
  await expect.element(page.getByText("Connected to Acme as @hina")).toBeVisible()
  await expect.element(disconnect()).toBeVisible()
  expect(appToken().query()).toBeNull()
  expect(connect().query()).toBeNull()
})

test("a failed connection shows Slack's reason, takes new tokens and clears them once sent", async () => {
  status = rejected
  afterConnect = rejected
  await renderSettings()
  await expect.element(page.getByText("Could not connect: invalid_auth")).toBeVisible()
  await expect.element(page.getByRole("link", { name: "Create Slack app" })).toBeVisible()

  await appToken().fill("xapp-1-abc")
  await botToken().fill("xoxb-2-def")
  await connect().click()
  await expect.poll(() => connects.length).toBe(1)
  await expect.element(appToken()).toHaveValue("")
  await expect.element(botToken()).toHaveValue("")
})

test("a refused connect shows its error and keeps the tokens", async () => {
  connectRefusal = "The keyring is locked"
  await renderSettings()
  await appToken().fill("xapp-1-abc")
  await botToken().fill("xoxb-2-def")
  await connect().click()
  await expect.element(page.getByText("The keyring is locked")).toBeVisible()
  await expect.element(appToken()).toHaveValue("xapp-1-abc")
  await expect.element(page.getByText("Not connected")).toBeVisible()
})

test("Disconnect returns to disconnected", async () => {
  status = connected
  await renderSettings()
  await expect.element(page.getByText("Connected to Acme as @hina")).toBeVisible()

  await disconnect().click()
  await expect.element(page.getByText("Not connected")).toBeVisible()
  expect(calls).toContain("slack.disconnect")
  await expect.element(appToken()).toHaveValue("")
  expect(disconnect().query()).toBeNull()
})

test("a slack.changed push refetches the status", async () => {
  status = { type: "connecting" }
  await renderSettings()
  await expect.element(page.getByText("Connecting…")).toBeVisible()

  status = connected
  for (const listener of pushListeners) listener({ type: "slack.changed" })
  await expect.element(page.getByText("Connected to Acme as @hina")).toBeVisible()
})
