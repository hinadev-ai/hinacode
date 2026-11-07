import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { beforeEach, expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import { type ArchiveSettings as Archive, defaultSettings } from "../../../shared/domain.ts"
import "../../index.css"
import { ArchiveSettings } from "./ArchiveSettings.tsx"

let saved: Array<Archive> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "settings.get") return { result: defaultSettings }
    if (method === "settings.set") {
      const { archive } = payload as { archive: Archive }
      saved.push(archive)
      return { result: { ...defaultSettings, archive } }
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
  saved = []
})

const renderSettings = async () => {
  const rootRoute = createRootRoute({ component: ArchiveSettings })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await router.load()
  return render(<RouterProvider router={router} />)
}

const settleDays = () => page.getByRole("spinbutton", { name: "Settle a quiet thread after" })
const archiveDays = () => page.getByRole("spinbutton", { name: "Archive a settled thread after" })

test("saves any number of days on Enter", async () => {
  await renderSettings()
  await expect.element(settleDays()).toHaveValue(7)
  await settleDays().fill("10")
  await userEvent.keyboard("{Enter}")
  await expect.poll(() => saved.at(-1)?.settleAfterIdleDays).toBe(10)
})

test("an empty field means never", async () => {
  await renderSettings()
  await expect.element(archiveDays()).toHaveAttribute("placeholder", "Never")
  await settleDays().fill("")
  await archiveDays().click()
  await expect.poll(() => saved.at(-1)?.settleAfterIdleDays).toBe(null)
})

test("a number out of range goes back to the saved value", async () => {
  await renderSettings()
  await settleDays().fill("0")
  await archiveDays().click()
  await expect.element(settleDays()).toHaveValue(7)
  expect(saved).toEqual([])
})
