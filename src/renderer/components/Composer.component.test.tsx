import { Schema } from "effect"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings, type Thread } from "../../shared/domain.ts"
import "../index.css"
import { useDrafts } from "../stores/drafts.ts"
import { Composer } from "./Composer.tsx"

const calls: Array<{ method: string; payload: unknown }> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    calls.push({ method, payload })
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "threads.interrupt") return { result: undefined }
    if (method === "attachments.stage")
      return {
        result: { id: "a-1", name: "notes.txt", path: "/tmp/notes.txt", mime: "text/plain", kind: "file", bytes: 1 },
      }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
}
Object.defineProperty(window, "hinacode", { value: bridge })

const threadWith = (id: string, status: Thread["status"]): Thread => ({
  id,
  projectId: "p-1",
  worktreeId: "w-1",
  title: "t",
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  userSkills: true,
  accessMode: "full",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status,
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
})

const dragFile = (type: "dragover" | "drop", target: Element) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File(["x"], "notes.txt", { type: "text/plain" }))
  target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }))
}

test("swaps Stop for Queue while a turn runs and the draft has text", async () => {
  const thread = threadWith("running", "running")
  await render(<Composer thread={thread} />)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  expect(calls).toContainEqual({ method: "threads.interrupt", payload: { threadId: thread.id } })

  useDrafts.getState().setText(thread.id, "actually, use the other file")
  await expect.element(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible()
  await expect.element(page.getByRole("button", { name: "Stop", exact: true })).not.toBeInTheDocument()
})

test("truncates a long model name instead of running under the toolbar buttons", async () => {
  const thread = { ...threadWith("idle", "idle"), model: "console-openrouter/deepseek/deepseek-v4.1-flash-1017" }
  await render(
    <div style={{ width: 320 }}>
      <Composer thread={thread} />
    </div>,
  )
  const send = page.getByRole("button", { name: "Send", exact: true })
  await expect.element(send).toBeVisible()

  const trigger = document.querySelector("[data-slot=composer-actions] [aria-haspopup]")!
  const actions = document.querySelector("[data-slot=composer-actions]")!
  expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(actions.getBoundingClientRect().right)
})

test("accepts files dropped on the toolbar, not only on the text line", async () => {
  const thread = threadWith("idle", "idle")
  await render(<Composer thread={thread} />)
  const toolbar = document.querySelector("[data-slot=composer-toolbar]")!

  dragFile("dragover", toolbar)
  await expect.element(page.getByText("Drop files to attach")).toBeVisible()

  dragFile("drop", toolbar)
  await expect.element(page.getByText("Drop files to attach")).not.toBeInTheDocument()
  await expect.poll(() => useDrafts.getState().byThreadId[thread.id]?.attachments.length).toBe(1)
  expect(calls.find((call) => call.method === "attachments.stage")?.payload).toMatchObject({
    threadId: thread.id,
    source: { name: "notes.txt" },
  })
})
