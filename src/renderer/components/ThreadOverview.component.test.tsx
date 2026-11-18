import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"
import "../index.css"
import { ThreadOverview } from "./ThreadOverview.tsx"

const mergeRequestUrl = "https://gitlab.com/group/app/-/merge_requests/7"
const permalink = "https://acme.slack.com/archives/C1/p1700000000000100"
const at = "2026-01-01T00:00:00.000Z"

const slackThread: Thread = {
  id: "slack-thread",
  projectId: "project",
  worktreeId: null,
  title: "From Slack",
  provider: "claude",
  model: "claude-opus-5-5",
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
  slack: { channelId: "C1", threadTs: "1700000000.000100", permalink, deliveredTs: "1700000000.000100" },
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: at,
  updatedAt: at,
}

let unlinks: Array<unknown> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "projects.list") {
      return {
        result: [{ id: "project", name: "app", rootPath: "/app", setupScript: null, createdAt: at, updatedAt: at }],
      } as never
    }
    if (method === "slack.unlink") {
      unlinks.push(payload)
      return { result: { ...slackThread, slack: null } }
    }
    if (method === "pullRequests.list") {
      if ((payload as { threadId: string }).threadId === slackThread.id) return { result: [] }
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

test("a thread started from Slack links to its Slack thread and can unlink it", async () => {
  unlinks = []
  await render(
    <div className="@container/thread w-[80rem]">
      <ThreadOverview thread={slackThread} />
    </div>,
  )

  const link = page.getByRole("link", { name: "Slack", exact: true })
  await expect.element(link).toHaveAttribute("href", permalink)
  await expect.element(link).toHaveAttribute("target", "_blank")

  await page.getByRole("button", { name: "Slack actions" }).click()
  await expect.element(page.getByRole("menuitem", { name: "Open in Slack" })).toHaveAttribute("href", permalink)
  await page.getByRole("menuitem", { name: "Unlink from thread" }).click()
  await expect.poll(() => unlinks).toEqual([{ threadId: slackThread.id }])
})
