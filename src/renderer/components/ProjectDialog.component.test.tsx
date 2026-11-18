import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import "../index.css"
import { ProjectDialog } from "./ProjectDialog.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "dialog.pickFolder") return { result: "C:\\Users\\me\\code" } as never
    if (method === "projects.list") return { result: [] } as never
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("a clone target picked in a Windows folder joins with a backslash", async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <ProjectDialog open onOpenChange={() => {}} source={{ rootPath: "https://github.com/octo/app", name: "app" }} />
    ),
  })
  await render(<RouterProvider router={createRouter({ routeTree: rootRoute, history: createMemoryHistory() })} />)

  await page.getByRole("group").filter({ hasText: "Clone to" }).getByRole("button", { name: "Browse…" }).click()

  await expect.element(page.getByLabelText("Clone to")).toHaveValue("C:\\Users\\me\\code\\app")
})

test("a folder path says a missing folder is created, a GitHub repository does not", async () => {
  const rootRoute = createRootRoute({ component: () => <ProjectDialog open onOpenChange={() => {}} /> })
  await render(<RouterProvider router={createRouter({ routeTree: rootRoute, history: createMemoryHistory() })} />)
  const hint = page.getByText("HinaCode creates the folder if it does not exist.")

  await page.getByLabelText("Folder or GitHub repository").fill("~/code/typo")
  await expect.element(hint).toBeVisible()

  await page.getByLabelText("Folder or GitHub repository").fill("https://github.com/octo/app")
  await expect.element(hint).not.toBeInTheDocument()
})
