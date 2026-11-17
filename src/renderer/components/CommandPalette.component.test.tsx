import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { Schema } from "effect"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings } from "../../shared/domain.ts"
import "../index.css"
import { usePalette } from "../palette/usePalette.ts"
import { useThreads } from "../stores/threads.ts"
import { CommandPalette } from "./CommandPalette.tsx"

const longTitle =
  "Refactor the worktree cleanup so archived threads release their ports and terminals before the folder goes"

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "projects.list") {
      return {
        result: [
          {
            id: "project-1",
            name: "hinacode",
            rootPath: "/home/dev/hinacode",
            setupScript: null,
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      } as never
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("a long thread title truncates inside the result list instead of scrolling it sideways", async () => {
  useThreads.setState({
    byId: {
      "thread-1": {
        id: "thread-1",
        projectId: "project-1",
        title: longTitle,
        provider: "claude",
        status: "idle",
        sortIndex: 0,
        pinnedAt: null,
      },
    },
    drafts: {},
    sidechats: {},
  } as never)
  usePalette.getState().show("worktree")
  const rootRoute = createRootRoute({ component: CommandPalette })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await render(<RouterProvider router={router} />)

  await expect.element(page.getByRole("option", { name: /^Refactor the worktree cleanup/ })).toBeVisible()

  const list = page.getByRole("listbox").element()
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth)
})
