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

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "settings.get") return { result: stored }
    if (method === "settings.set") {
      const patch = payload as Partial<Settings>
      if (patch.providerEnabled !== undefined) sent.push(patch.providerEnabled)
      if (sent.length === 1) await new Promise<void>((resolve) => (releaseFirstSave = resolve))
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
})

const renderSettings = async () => {
  const rootRoute = createRootRoute({ component: ModelSettings })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await router.load()
  return render(<RouterProvider router={router} />)
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
