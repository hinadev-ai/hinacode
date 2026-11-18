import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import {
  defaultSettings,
  type ExperimentalSettings,
  type Routine,
  type Settings,
  type SlackStatus,
  type SlackTokens,
} from "../../../shared/domain.ts"
import "../../index.css"
import { SlackSettings } from "./SlackSettings.tsx"

const disconnected: SlackStatus = { type: "disconnected" }
const rejected: SlackStatus = { type: "failed", reason: "invalid_auth" }
const connected: SlackStatus = { type: "connected", team: "Acme", botUser: "hina", owner: null, pairingCode: null }
const mei = { teamId: "T1", userId: "U1", name: "Mei" }
const at = "2026-01-01T00:00:00.000Z"
const routineNamed = (id: string, name: string): Routine => ({
  id,
  projectId: "project",
  name,
  enabled: true,
  prompt: "Answer the thread",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: null,
  workspace: "worktree",
  schedule: null,
  nextRunAt: null,
  lastRun: null,
  createdAt: at,
  updatedAt: at,
})

let status: SlackStatus = disconnected
let afterConnect: SlackStatus = { type: "connecting" }
let connectRefusal: string | null = null
let calls: Array<string> = []
let connects: Array<SlackTokens> = []
let patches: Array<Partial<ExperimentalSettings>> = []
let settings: Settings = defaultSettings
let settingsPatches: Array<unknown> = []
let routines: Array<Routine> = []
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
    if (method === "slack.pair") {
      if (status.type === "connected") status = { ...status, pairingCode: "K7QM2XPD" }
      return { result: status }
    }
    if (method === "settings.get") return { result: settings }
    if (method === "settings.set") {
      const patch = payload as { slack: Settings["slack"] }
      settingsPatches.push(patch)
      settings = { ...settings, slack: { ...settings.slack, ...patch.slack } }
      return { result: settings }
    }
    if (method === "projects.list") {
      return {
        result: [{ id: "project", name: "app", rootPath: "/app", setupScript: null, createdAt: at, updatedAt: at }],
      } as never
    }
    if (method === "routines.list") return { result: routines }
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
  afterConnect = { type: "connecting" }
  connectRefusal = null
  calls = []
  connects = []
  patches = []
  settings = defaultSettings
  settingsPatches = []
  routines = []
})

const renderSettings = async ({ slack = true }: { slack?: boolean } = {}) => {
  const rootRoute = createRootRoute({
    component: () => (
      <RegistryProvider>
        <SlackSettings
          experimental={{ ...defaultSettings.experimental, slack }}
          setExperimental={async (patch) => {
            patches.push(patch)
          }}
        />
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

test("the switch alone shows while Slack is off", async () => {
  await renderSettings({ slack: false })
  await expect.element(page.getByRole("switch", { name: "Slack" })).not.toBeChecked()
  expect(page.getByText("Not connected").query()).toBeNull()
  expect(page.getByRole("link", { name: "Create Slack app" }).query()).toBeNull()
  expect(connect().query()).toBeNull()
  expect(calls).not.toContain("slack.status")

  await page.getByRole("switch", { name: "Slack" }).click()
  await expect.poll(() => patches).toEqual([{ slack: true }])
})

test("connects once both tokens have their prefix, with the tokens trimmed", async () => {
  await renderSettings()
  await expect.element(page.getByText("Not connected")).toBeVisible()
  await expect.element(page.getByRole("link", { name: "Create Slack app" })).toHaveAttribute("target", "_blank")
  expect(page.getByRole("button", { name: "Disconnect" }).query()).toBeNull()
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
  await expect.element(page.getByText("Connecting")).toBeVisible()
  await expect.element(page.getByRole("button", { name: "Disconnect" })).toBeVisible()
  expect(connect().query()).toBeNull()
})

test("a failed connection shows Slack's reason and takes new tokens", async () => {
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

  await page.getByRole("button", { name: "Disconnect" }).click()
  await expect.element(page.getByText("Not connected")).toBeVisible()
  expect(calls).toContain("slack.disconnect")
})

test("a refused call shows its error and keeps the tokens", async () => {
  connectRefusal = "The keyring is locked"
  await renderSettings()
  await appToken().fill("xapp-1-abc")
  await botToken().fill("xoxb-2-def")
  await connect().click()
  await expect.element(page.getByText("The keyring is locked")).toBeVisible()
  await expect.element(appToken()).toHaveValue("xapp-1-abc")
  await expect.element(page.getByText("Not connected")).toBeVisible()
})

test("pairing shows the code to send to the bot", async () => {
  status = connected
  await renderSettings()
  await expect.element(page.getByText("Connected to Acme as @hina")).toBeVisible()
  expect(page.getByText(/Paired with/).query()).toBeNull()

  await page.getByRole("button", { name: "Pair", exact: true }).click()
  await expect.element(page.getByText("K7QM2XPD")).toBeVisible()
  await expect.element(page.getByText("Send this code to @hina in a direct message.")).toBeVisible()
  await expect.element(page.getByRole("button", { name: "Copy pairing code" })).toBeVisible()
  expect(calls).toContain("slack.pair")
  expect(page.getByRole("button", { name: "Pair", exact: true }).query()).toBeNull()
})

test("a paired connection names its owner", async () => {
  status = { ...connected, owner: mei }
  await renderSettings()
  await expect.element(page.getByText("Paired with Mei")).toBeVisible()
  await expect.element(page.getByRole("button", { name: "Pair again" })).toBeVisible()
})

test("a slack.changed push refetches the status", async () => {
  await renderSettings()
  await expect.element(page.getByText("Not connected")).toBeVisible()

  status = { ...connected, owner: mei }
  for (const listener of pushListeners) listener({ type: "slack.changed" })
  await expect.element(page.getByText("Connected to Acme as @hina")).toBeVisible()
  await expect.element(page.getByText("Paired with Mei")).toBeVisible()
  expect(page.getByLabelText("App token").query()).toBeNull()
})

const routinePicker = () => page.getByRole("combobox", { name: "Routine" })

test("the routine picker lists the machine's routines and stores the choice", async () => {
  status = connected
  routines = [routineNamed("triage", "Triage"), routineNamed("deploy", "Deploy")]
  await renderSettings()
  await expect.element(routinePicker()).toHaveTextContent("None")

  await routinePicker().click()
  await expect.element(page.getByRole("option", { name: "Triage", exact: true })).toBeVisible()
  await page.getByRole("option", { name: "Deploy", exact: true }).click()
  await expect.poll(() => settingsPatches).toEqual([{ slack: { routineId: "deploy" } }])
  await expect.element(routinePicker()).toHaveTextContent("Deploy")

  await routinePicker().click()
  await page.getByRole("option", { name: "None", exact: true }).click()
  await expect.poll(() => settingsPatches.at(-1)).toEqual({ slack: { routineId: null } })
  await expect.element(routinePicker()).toHaveTextContent("None")
})

test("a stored routine that no longer exists reads as None", async () => {
  status = connected
  routines = [routineNamed("triage", "Triage")]
  settings = { ...defaultSettings, slack: { owner: null, routineId: "deleted" } }
  await renderSettings()
  await expect.element(routinePicker()).toHaveTextContent("None")
  await expect.element(routinePicker()).toBeEnabled()
})

test("without routines the picker is disabled", async () => {
  status = connected
  await renderSettings()
  await expect.element(routinePicker()).toHaveTextContent("No routines")
  await expect.element(routinePicker()).toBeDisabled()
})
