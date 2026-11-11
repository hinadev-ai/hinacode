import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { PullRequestLink, Thread, Worktree } from "../../shared/domain.ts"
import "../index.css"
import { usePullRequests } from "../stores/pullRequests.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { ComposerStatusLine } from "./ComposerStatusLine.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "projects.currentBranch") return { result: "main" } as never
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const threadOf = (id: string, worktreeId: string | null) => ({ id, projectId: "project", worktreeId }) as Thread

test("a GitLab merge request reads !N", async () => {
  usePullRequests
    .getState()
    .replace("gitlab", [{ url: "https://gitlab.com/group/app/-/merge_requests/7" } as PullRequestLink])

  const screen = await render(<ComposerStatusLine thread={threadOf("gitlab", null)} />)

  await expect.element(screen.getByRole("link")).toHaveTextContent("!7")
})

test("a removed worktree falls back to the project's branch", async () => {
  useWorktrees.getState().upsert({
    id: "gone",
    branch: "feat/gone",
    path: "/worktrees/gone",
    status: "removed",
  } as Worktree)

  await render(<ComposerStatusLine thread={threadOf("removed", "gone")} />)

  await expect.element(page.getByText("main", { exact: true })).toBeVisible()
  expect(page.getByText("feat/gone").query()).toBeNull()
  expect(document.querySelector('[title="/worktrees/gone"]')).toBeNull()
})
