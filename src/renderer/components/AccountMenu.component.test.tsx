import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { RelayAccountStatus } from "../../shared/domain.ts"
import "../index.css"
import { AccountMenu } from "./AccountMenu.tsx"

let status: RelayAccountStatus = { state: "signedOut" }
const called: Array<string> = []

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    called.push(method)
    if (method === "relayAccount.status" || method === "relayAccount.signIn") return { result: status }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const renderMenu = async () => {
  const rootRoute = createRootRoute({ component: AccountMenu })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await router.load()
  return render(<RouterProvider router={router} />)
}

const signedIn: RelayAccountStatus = {
  state: "signedIn",
  serviceUrl: "https://relay.test",
  environmentId: "env",
  name: "Kalan",
  email: "kalan@example.com",
  machines: 0,
  syncedAt: null,
  error: null,
}

test("closes the menu after following a link", async () => {
  await renderMenu()
  await page.getByRole("button", { name: "Account" }).click()
  await page.getByRole("menuitem", { name: "Connected Devices" }).click()
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument()
})

test("signs in from the menu, then shows who is signed in and asks before logging out", async () => {
  await renderMenu()
  await page.getByRole("button", { name: "Account" }).click()
  await expect.element(page.getByRole("menuitem", { name: "Connected Devices" })).toBeVisible()
  await expect.element(page.getByRole("menuitem", { name: "Settings" })).toBeVisible()
  await expect.element(page.getByRole("menuitem", { name: "Logout" })).not.toBeInTheDocument()

  status = signedIn
  await page.getByRole("menuitem", { name: "Login" }).click()
  await expect.poll(() => called).toContain("relayAccount.signIn")
  await expect.element(page.getByRole("button", { name: "Account" })).toHaveTextContent("K")

  await page.getByRole("button", { name: "Account" }).click()
  await expect.element(page.getByText("Kalan")).toBeVisible()
  await expect.element(page.getByRole("menuitem", { name: "Login" })).not.toBeInTheDocument()
  await page.getByRole("menuitem", { name: "Logout" }).click()
  await expect.element(page.getByRole("alertdialog")).toBeVisible()
  expect(called).not.toContain("relayAccount.signOut")
})
