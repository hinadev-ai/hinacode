import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Environments } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { CloudNotice } from "./CloudNotice.tsx"

const studio: Environments["clouds"][number] = {
  id: "machine-1",
  name: "studio",
  host: "studio.relay.example",
  port: 7420,
  relay: "studio.relay.example",
  source: "relay",
  createdAt: "2026-11-01T00:00:00.000Z",
  status: "unauthorized",
  refusal: "refused",
  lastSeenAt: null,
}

const environments: Environments = {
  clouds: [
    studio,
    { ...studio, id: "machine-2", name: "lab", status: "approval", approval: { code: "K7Q-F2M", accepted: true } },
  ],
}
const calls: Array<{ readonly method: string; readonly payload: unknown }> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "environments.list") return { result: environments }
    if (method === "environments.repair" || method === "environments.confirmHost") {
      calls.push({ method, payload })
      return { result: undefined } as never
    }
    if (method === "projects.list") {
      return {
        result: ["machine-1", "machine-2"].map((environmentId, index) => ({
          id: `project-${index + 1}`,
          name: "web",
          rootPath: "/home/studio/web",
          setupScript: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          environmentId,
        })),
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

const renderNotice = async (threadId: string) => {
  useThreads.setState({
    byId: {
      "thread-1": { id: "thread-1", projectId: "project-1" },
      "thread-2": { id: "thread-2", projectId: "project-2" },
    },
    drafts: {},
    sidechats: {},
  } as never)
  const rootRoute = createRootRoute({ component: () => <CloudNotice threadId={threadId} /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await render(<RouterProvider router={router} />)
}

test("a machine that refused this device offers pairing again with the relay's key, not the desktop's form", async () => {
  await renderNotice("thread-1")

  await expect
    .element(
      page.getByText("studio did not accept this device. If you reset its pairing, pair again from its QR code."),
    )
    .toBeVisible()
  await page.getByRole("button", { name: "Pair again", exact: true }).click()
  await expect.poll(() => calls).toContainEqual({ method: "environments.repair", payload: { id: "machine-1" } })
})

test("a machine that accepted the code asks whether it did before anything runs there", async () => {
  await renderNotice("thread-2")

  await expect.element(page.getByText("Did lab accept the code?")).toBeVisible()
  await page.getByRole("button", { name: "Yes", exact: true }).click()
  await expect
    .poll(() => calls)
    .toContainEqual({ method: "environments.confirmHost", payload: { id: "machine-2", accepted: true } })
})
