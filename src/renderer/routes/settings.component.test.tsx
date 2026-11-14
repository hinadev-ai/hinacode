import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import {
  applySettingsPatch,
  defaultSettings,
  type Environments,
  type RelayStatus,
  type Settings,
  type SettingsPatch,
} from "../../shared/domain.ts"
import "../index.css"
import { SettingsRoute } from "./settings.tsx"

const AGENT = "environment-agent"
const TAILSCALE = "100.64.0.7"

const agent: Environments["clouds"][number] = {
  id: AGENT,
  name: "agent",
  host: TAILSCALE,
  port: 48081,
  relay: null,
  source: "pairing",
  createdAt: "2026-11-10T00:00:00.000Z",
  status: "connected",
  lastSeenAt: null,
}

const listeningOn = (bindHost: string): Settings => ({
  ...defaultSettings,
  remote: { enabled: true, bindHost, port: 48081 },
})

let settingsOf: Record<string, Settings> = {}
let relayOf: Record<string, RelayStatus> = {}
let saved: Array<{ machine: string; remote: unknown }> = []

const THIS_MACHINE = "this machine"

const bridge: HinacodeBridge = {
  rpc: async (method, payload, environment) => {
    const machine = environment ?? THIS_MACHINE
    if (method === "environments.list") return { result: { clouds: [agent] } }
    if (method === "settings.get") return { result: settingsOf[machine] }
    if (method === "settings.set") {
      const patch = payload as SettingsPatch<Settings>
      saved.push({ machine, remote: patch.remote })
      settingsOf[machine] = applySettingsPatch(settingsOf[machine]!, patch)
      return { result: settingsOf[machine] }
    }
    if (method === "remote.status")
      return { result: { listening: true, listenError: null, connected: 1, relay: relayOf[machine] } }
    if (method === "network.addresses")
      return {
        result: environment === AGENT ? [{ name: "tailscale0", address: TAILSCALE }] : [],
      }
    if (method === "remote.pairing")
      return { result: { hosts: ["192.168.1.2"], port: 48081, token: "token", relay: null } }
    if (method === "relayAccount.status") return { result: { state: "signedOut" } }
    if (method === "updates.status") return { result: { current: "1.0.0", state: { type: "idle" } } }
    if (method === "updates.check") return { result: undefined }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

beforeEach(async () => {
  await page.viewport(1280, 900)
  settingsOf = { [THIS_MACHINE]: listeningOn("private"), [AGENT]: listeningOn(TAILSCALE) }
  relayOf = { [THIS_MACHINE]: { state: "off" }, [AGENT]: { state: "off" } }
  saved = []
})

const openConnections = async (environment?: string) => {
  const rootRoute = createRootRoute()
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsRoute,
    validateSearch: (search: Record<string, unknown>): { page?: string; environment?: string } => ({
      ...(typeof search.page === "string" ? { page: search.page } : {}),
      ...(typeof search.environment === "string" ? { environment: search.environment } : {}),
    }),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({
      initialEntries: [`/settings?page=connections${environment === undefined ? "" : `&environment=${environment}`}`],
    }),
  })
  await router.load()
  return render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>,
  )
}

const listener = () => page.getByRole("combobox", { name: "Remote listener" })

const pickListener = async (name: string) => {
  await listener().click()
  await page.getByRole("option", { name, exact: true }).click()
}

test("the Remote section edits the machine its picker names", async () => {
  relayOf[AGENT] = { state: "connected", hostname: "agent.hinacode.app" }
  await openConnections()
  await expect.element(listener()).toHaveTextContent("Local network and Tailscale")
  await expect.element(page.getByRole("switch", { name: "Allow remote control" })).toBeVisible()

  await page.getByRole("combobox", { name: "Editing settings for" }).click()
  await page.getByRole("option", { name: "agent", exact: true }).click()

  await expect.element(listener()).toHaveTextContent(`tailscale0 (${TAILSCALE})`)
  await expect.element(page.getByText("Reachable at agent.hinacode.app")).toBeVisible()
  await pickListener("Local network and Tailscale")

  await expect.poll(() => saved).toEqual([{ machine: AGENT, remote: { bindHost: "private" } }])
  await expect.element(listener()).toHaveTextContent("Local network and Tailscale")
  expect(settingsOf[THIS_MACHINE]).toEqual(listeningOn("private"))
})

test("another machine offers nothing that would lock this device out of it", async () => {
  await openConnections(AGENT)
  await expect.element(listener()).toBeVisible()

  expect(page.getByRole("switch", { name: "Allow remote control" }).query()).toBeNull()
  expect(page.getByRole("spinbutton", { name: "Port" }).query()).toBeNull()
  expect(page.getByRole("heading", { name: "Pair a phone" }).query()).toBeNull()
})

test("without a relay, a listener that stops answering this device needs a confirmation", async () => {
  await openConnections(AGENT)
  await pickListener("This machine only (127.0.0.1)")

  const dialog = page.getByRole("alertdialog", { name: "Change the listener on agent?" })
  await expect.element(dialog).toBeVisible()
  await expect
    .element(
      dialog.getByText(
        `This device reaches agent at ${TAILSCALE}:48081, and agent is not reachable through the relay. If the new listener does not answer at that address, the connection drops and you can only change it back on agent itself.`,
      ),
    )
    .toBeVisible()
  expect(saved).toEqual([])

  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect.element(listener()).toHaveTextContent(`tailscale0 (${TAILSCALE})`)
  expect(saved).toEqual([])

  await pickListener("This machine only (127.0.0.1)")
  await dialog.getByRole("button", { name: "Change listener" }).click()
  await expect.poll(() => saved).toEqual([{ machine: AGENT, remote: { bindHost: "127.0.0.1" } }])
})

test("without a relay, the address this device dials is saved at once", async () => {
  settingsOf[AGENT] = listeningOn("private")
  await openConnections(AGENT)
  await pickListener(`tailscale0 (${TAILSCALE})`)

  await expect.poll(() => saved).toEqual([{ machine: AGENT, remote: { bindHost: TAILSCALE } }])
  expect(page.getByRole("alertdialog").query()).toBeNull()
})
