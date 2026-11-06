import { Schema } from "effect"
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings } from "../../shared/domain.ts"
import "../index.css"
import { TitleBar } from "./TitleBar.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "relayAccount.status") return { result: { state: "signedOut" } }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("the settings link renders without a Base UI native button warning", async () => {
  const consoleError = vi.spyOn(console, "error")
  const rootRoute = createRootRoute({
    component: () => <TitleBar compact={false} sidebarButtonRef={{ current: null }} />,
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await router.load()
  render(<RouterProvider router={router} />)

  await expect.element(page.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings")
  expect(consoleError.mock.calls.flat().join("\n")).not.toContain("nativeButton")
})
