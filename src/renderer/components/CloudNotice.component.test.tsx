import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Environments } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { CloudNotice } from "./CloudNotice.tsx"

const environments: Environments = {
  clouds: [
    {
      id: "machine-1",
      name: "studio",
      host: "studio.relay.example",
      port: 7420,
      relay: "studio.relay.example",
      source: "relay",
      createdAt: "2026-11-01T00:00:00.000Z",
      status: "unauthorized",
      lastSeenAt: null,
    },
  ],
}

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "environments.list") return { result: environments }
    if (method === "projects.list") {
      return {
        result: [
          {
            id: "project-1",
            name: "web",
            rootPath: "/home/studio/web",
            setupScript: null,
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
            environmentId: "machine-1",
          },
        ],
      } as never
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("a browser offers a reload, not the desktop's pairing form, when a machine refuses its token", async () => {
  useThreads.setState({
    byId: { "thread-1": { id: "thread-1", projectId: "project-1" } },
    drafts: {},
    sidechats: {},
  } as never)
  const rootRoute = createRootRoute({ component: () => <CloudNotice threadId="thread-1" /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await render(<RouterProvider router={router} />)

  await expect
    .element(page.getByText("studio refused its token. Reload this page after it publishes a new one to the relay."))
    .toBeVisible()
  await expect.element(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible()
  expect(page.getByText("Pair again").elements()).toEqual([])
})
