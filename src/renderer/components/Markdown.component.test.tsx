import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { PullRequest } from "../../shared/domain.ts"
import { ThreadRepository } from "../lib/threadRepository.ts"
import "../index.css"
import { Markdown } from "./Markdown.tsx"

const existing = "https://github.com/hinadev-ai/hinacode/pull/7"
const issueUrl = "https://github.com/hinadev-ai/hinacode/issues/756"

const pullRequest: PullRequest = {
  url: existing,
  number: 7,
  title: "Change 7",
  status: "open",
  checks: null,
  review: null,
  mergeable: "mergeable",
  author: "octocat",
  headRefName: "feat/7",
  baseRefName: "main",
  additions: 1,
  deletions: 0,
}

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "github.pullRequest" && (payload as { url: string }).url === existing) {
      return { result: pullRequest } as never
    }
    if (method === "github.issue" && (payload as { url: string }).url === issueUrl) {
      return {
        result: {
          url: issueUrl,
          number: 756,
          title: "Relay keeps the old owner table",
          status: "open",
          author: "octocat",
        },
      } as never
    }
    if (method === "github.pullRequest") {
      return { error: { tag: "GitHubError", message: "Could not resolve to a PullRequest" } }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const renderMarkdown = (text: string) => {
  const rootRoute = createRootRoute({
    component: () => (
      <ThreadRepository value={{ owner: "hinadev-ai", name: "hinacode" }}>
        <Markdown text={text} />
      </ThreadRepository>
    ),
  })
  return render(<RouterProvider router={createRouter({ routeTree: rootRoute, history: createMemoryHistory() })} />)
}

test("links #n only when the thread's repository has that pull request", async () => {
  await renderMarkdown("Fixed in #7. Other repos discuss it in #27949.")

  await expect.element(page.getByRole("link", { name: "#7" })).toHaveAttribute("href", existing)
  await expect.element(page.getByRole("link", { name: "#27949" })).not.toBeInTheDocument()
  await expect.element(page.getByRole("paragraph")).toHaveTextContent("Fixed in #7. Other repos discuss it in #27949.")
})

test("links #n to the issue and previews it when that number is an issue", async () => {
  await renderMarkdown("Tracked in #756.")

  const link = page.getByRole("link", { name: "#756" })
  await expect.element(link).toHaveAttribute("href", issueUrl)
  await link.hover()
  await expect.element(page.getByText("Relay keeps the old owner table")).toBeVisible()
})
