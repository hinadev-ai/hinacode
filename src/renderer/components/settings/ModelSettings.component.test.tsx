import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import { defaultSettings, type Settings } from "../../../shared/domain.ts"
import "../../index.css"
import { ModelSettings } from "./ModelSettings.tsx"

let stored: Settings = defaultSettings
let sent: Array<Settings["providerEnabled"]> = []
let releaseFirstSave: () => void = () => {}
let codexAt: string | null = null

const binaries = () => ({
  claude: { installed: true, path: "/usr/bin/claude" },
  codex: codexAt === null ? { installed: false, path: null } : { installed: true, path: codexAt },
  muse: { installed: true, path: "/usr/bin/muse" },
  opencode: { installed: true, path: "/usr/bin/opencode" },
  magpie: { installed: true, path: "/usr/bin/claude" },
})

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "settings.get") return { result: stored }
    if (method === "agents.binaries") return { result: binaries() }
    if (method === "settings.set") {
      const patch = payload as Partial<Settings>
      if (patch.providerEnabled !== undefined) sent.push(patch.providerEnabled)
      if (patch.providerBinary !== undefined) codexAt = patch.providerBinary.codex
      if (patch.providerEnabled !== undefined && sent.length === 1)
        await new Promise<void>((resolve) => (releaseFirstSave = resolve))
      stored = { ...stored, ...patch }
      return { result: stored }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

beforeEach(() => {
  stored = defaultSettings
  sent = []
  codexAt = "/usr/bin/codex"
})

const renderSettings = async () => {
  const rootRoute = createRootRoute({ component: ModelSettings })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await router.load()
  return render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>,
  )
}

test("keeps an earlier agent switch when a second one flips before the first save returns", async () => {
  await renderSettings()
  await page.getByRole("switch", { name: "Enable Codex" }).click()
  await expect.poll(() => sent.length).toBe(1)
  await page.getByRole("switch", { name: "Enable Muse Code" }).click()
  releaseFirstSave()

  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]).toMatchObject({ codex: false, muse: false })
  await expect.poll(() => stored.providerEnabled).toMatchObject({ codex: false, muse: false })
})

test("turns off an agent whose CLI is missing until its path is set", async () => {
  codexAt = null
  await renderSettings()
  const toggle = page.getByRole("switch", { name: "Enable Codex" })
  await expect.element(toggle).not.toBeChecked()
  await expect.element(toggle).toHaveAttribute("aria-disabled", "true")

  await page.getByRole("button", { name: "Codex Not installed" }).click()
  await expect.element(page.getByText("Codex was not found on this machine.")).toBeVisible()
  await page.getByRole("textbox", { name: "CLI path" }).fill("/opt/codex/bin/codex")
  await page.getByRole("button", { name: "Save" }).click()

  await expect.element(toggle).toBeChecked()
  expect(stored.providerBinary.codex).toBe("/opt/codex/bin/codex")
})
