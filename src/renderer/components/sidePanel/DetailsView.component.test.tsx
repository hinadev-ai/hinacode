import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import type { Thread } from "../../../shared/domain.ts"
import "../../index.css"
import { useWorktrees } from "../../stores/worktrees.ts"
import { DetailsView } from "./DetailsView.tsx"

const missingFolder = "The folder /tmp/gone is missing. It was moved or deleted."

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "worktrees.checkoutState") return { result: "missing" }
    if (method === "worktrees.pullRequest") return { result: null }
    if (method === "ports.list") return { error: { tag: "NotFound", message: missingFolder } }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => undefined,
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const thread: Thread = {
  id: "t-1",
  projectId: "p-1",
  worktreeId: "w-1",
  title: "t",
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  accessMode: "full",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
}

test("a worktree whose folder is gone shows no ports section to retry", async () => {
  useWorktrees.getState().replaceAll([
    {
      id: "w-1",
      projectId: "p-1",
      path: "/tmp/gone",
      branch: "feat/gone",
      baseRef: "main",
      status: "ready",
      setupLog: "",
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ])
  await render(<DetailsView thread={thread} />)

  await expect.element(page.getByText("Folder missing")).toBeVisible()
  expect(page.getByText("Ports", { exact: true }).elements()).toEqual([])
  expect(page.getByRole("button", { name: "Retry" }).elements()).toEqual([])
})
