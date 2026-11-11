import { expect, test } from "vitest"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { PullRequestLink, Thread } from "../../shared/domain.ts"
import "../index.css"
import { usePullRequests } from "../stores/pullRequests.ts"
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
