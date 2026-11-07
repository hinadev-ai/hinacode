import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { PullRequestDetail, PullRequestEdit } from "../../shared/domain.ts"
import "../index.css"
import { PullRequestMetadata } from "./PullRequestMetadata.tsx"

const edits: Array<PullRequestEdit> = []
const pendingEdits: Array<() => void> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "github.auth") return { result: { type: "signedIn", host: "github.com", login: "octocat" } }
    if (method === "github.pullRequestCandidates") {
      return { result: { labels: [{ name: "bug", color: "d73a4a" }], users: ["octocat"] } }
    }
    if (method === "github.editPullRequest") {
      edits.push((payload as { edit: PullRequestEdit }).edit)
      await new Promise<void>((resolve) => pendingEdits.push(resolve))
      return { result: undefined }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
} as never
Object.defineProperty(window, "hinacode", { value: bridge })

const pullRequest = {
  url: "https://github.com/o/r/pull/7",
  author: "octocat",
  labels: [],
  assignees: [],
  reviewers: [],
} as unknown as PullRequestDetail

test("adding then removing a label before GitHub answers removes it, one write after the other", async () => {
  const rootRoute = createRootRoute({ component: () => <PullRequestMetadata pullRequest={pullRequest} /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await render(<RouterProvider router={router} />)

  await page.getByRole("button", { name: "Labels None" }).click()
  const bug = page.getByRole("option", { name: "bug" })
  await bug.click()
  await bug.click()
  await expect.poll(() => edits.length).toBe(1)
  pendingEdits.shift()?.()
  await expect.poll(() => edits.length).toBe(2)
  pendingEdits.shift()?.()

  expect(edits).toStrictEqual([
    { field: "labels", add: ["bug"], remove: [] },
    { field: "labels", add: [], remove: ["bug"] },
  ])
  await userEvent.keyboard("{Escape}")
})
