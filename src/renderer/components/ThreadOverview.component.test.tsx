import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"
import "../index.css"
import { ThreadOverview } from "./ThreadOverview.tsx"

const mergeRequestUrl = "https://gitlab.com/group/app/-/merge_requests/7"
const at = "2026-01-01T00:00:00.000Z"

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "projects.list") {
      return {
        result: [{ id: "project", name: "app", rootPath: "/app", setupScript: null, createdAt: at, updatedAt: at }],
      } as never
    }
    if (method === "pullRequests.list") {
      return { result: [{ id: "link", threadId: "thread", url: mergeRequestUrl, createdAt: at, watch: null }] } as never
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("a GitLab merge request is named and opened as one", async () => {
  await render(
    <div className="@container/thread w-[80rem]">
      <ThreadOverview thread={{ id: "thread", projectId: "project", worktreeId: null } as Thread} />
    </div>,
  )

  const row = page.getByTitle(mergeRequestUrl)
  await expect.element(row).toHaveTextContent("group/app!7")

  await page.getByRole("button", { name: "Pull request actions" }).click()
  await expect.element(page.getByRole("menuitem", { name: "View !7" })).toBeVisible()
  await expect.element(page.getByRole("menuitem", { name: "Open on GitLab" })).toBeVisible()
})
