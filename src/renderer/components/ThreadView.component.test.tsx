import { Schema } from "effect"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings, Thread } from "../../shared/domain.ts"
import "../index.css"
import { selectOpenableThread, useThreads } from "../stores/threads.ts"
import { ThreadView } from "./ThreadView.tsx"

const archived: Thread = {
  id: "t-archived",
  projectId: "p-1",
  worktreeId: null,
  title: "Summarize the README",
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
  status: "archived",
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

const calls: Array<{ method: string; payload: unknown }> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    calls.push({ method, payload })
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "threads.transcript")
      return { result: { messages: [], approvals: [], questions: [], secretRequests: [], seq: 0 } }
    if (method === "threads.unarchive") return { result: Schema.encodeSync(Thread)({ ...archived, status: "idle" }) }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

function OpenThread({ id }: { id: string }) {
  const thread = useThreads(selectOpenableThread(id))
  return <div className="flex h-[720px] w-[960px]">{thread && <ThreadView thread={thread} />}</div>
}

test("an archived thread says so, warns that sending reopens it, and reopens from the view", async () => {
  useThreads.getState().upsert(archived)
  await render(<OpenThread id={archived.id} />)

  await expect.element(page.getByRole("banner").getByText("Archived", { exact: true })).toBeVisible()
  await expect.element(page.getByText("Sending a message reopens this thread.")).toBeVisible()

  await page.getByRole("button", { name: "Reopen", exact: true }).click()

  expect(calls).toContainEqual({ method: "threads.unarchive", payload: { threadId: archived.id } })
  await expect.element(page.getByRole("banner").getByText("Archived", { exact: true })).not.toBeInTheDocument()
  await expect.element(page.getByRole("button", { name: "Reopen", exact: true })).not.toBeInTheDocument()
})
