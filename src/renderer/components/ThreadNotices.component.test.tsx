import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { ThreadNotices } from "./ThreadView.tsx"

const interrupted: Thread = {
  id: "thread-1",
  projectId: "project-1",
  worktreeId: null,
  title: "Migrate the billing tables",
  provider: "claude",
  model: "m",
  effort: null,
  fastMode: false,
  accessMode: "auto",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "interrupted",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
}

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method !== "threads.resume") return { error: { tag: "NotStubbed", message: method } }
    useThreads.getState().upsert({ ...interrupted, status: "running" })
    return { result: undefined }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

function Notices() {
  const thread = useThreads((state) => state.byId["thread-1"])
  return thread === undefined ? null : <ThreadNotices thread={thread} />
}

test("Resume removes the interrupted callout once the thread runs", async () => {
  useThreads.setState({ byId: { "thread-1": interrupted }, drafts: {}, sidechats: {} })
  const rootRoute = createRootRoute({ component: Notices })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await render(<RouterProvider router={router} />)
  await expect.element(page.getByRole("heading", { name: "Interrupted by a restart" })).toBeVisible()

  await page.getByRole("button", { name: "Resume" }).click()

  await expect.poll(() => useThreads.getState().byId["thread-1"]?.status).toBe("running")
  await expect.element(page.getByRole("heading", { name: "Interrupted by a restart" })).not.toBeInTheDocument()
})
