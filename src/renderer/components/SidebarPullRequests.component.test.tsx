import { expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { PullRequest } from "../../shared/domain.ts"
import "../index.css"
import { SidebarPullRequests } from "./SidebarPullRequests.tsx"

const urls = [1, 2, 3].map((number) => `https://github.com/o/r/pull/${number}`)
const pullRequestOf = (url: string): PullRequest => {
  const number = Number(url.split("/").at(-1))
  return {
    url,
    number,
    title: `Change ${number}`,
    status: "open",
    checks: null,
    review: null,
    mergeable: "mergeable",
    author: "octocat",
    headRefName: `feat/${number}`,
    baseRefName: "main",
    additions: 1,
    deletions: 0,
  }
}

const mergeCalls: Array<string> = []
const merged = new Set<string>()
let failNextMergeOf: string | null = urls[1]!

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "github.pullRequest") {
      return { result: pullRequestOf((payload as { url: string }).url) } as never
    }
    if (method === "github.merge") {
      const { url } = payload as { url: string }
      mergeCalls.push(url)
      if (merged.has(url)) return { error: { tag: "GitHubError", message: "Pull request is already merged" } }
      if (url === failNextMergeOf) {
        failNextMergeOf = null
        return { error: { tag: "GitHubError", message: "Required checks are pending" } }
      }
      merged.add(url)
      return { result: undefined }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("retrying Merge all after a failure continues with the pull requests still unmerged", async () => {
  await render(
    <SidebarPullRequests
      threadId="thread"
      links={urls.map((url) => ({ url }) as never)}
      environment={"local" as never}
    />,
  )

  await userEvent.hover(page.getByRole("button", { name: "3 linked pull requests" }))
  await page.getByRole("button", { name: "Merge all (3)" }).click()
  const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Squash and merge" })
  await confirm.click()
  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't merge #2: Required checks are pending")

  await confirm.click()
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument()

  expect(mergeCalls).toStrictEqual([urls[0], urls[1], urls[1], urls[2]])
})
