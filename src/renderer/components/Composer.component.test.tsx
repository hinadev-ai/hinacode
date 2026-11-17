import { Schema } from "effect"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings, type Message, type Thread } from "../../shared/domain.ts"
import "../index.css"
import { useDrafts } from "../stores/drafts.ts"
import { useMessages } from "../stores/messages.ts"
import { useUi } from "../stores/ui.ts"
import { Composer } from "./Composer.tsx"

const calls: Array<{ method: string; payload: unknown }> = []
const missingFolder = "/tmp/repo/.hinacode-worktrees/repo/kk-fix-login-form-b21a5dbc"

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    calls.push({ method, payload })
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "commands.list" && (payload as { threadId: string }).threadId.startsWith("folder-missing"))
      return {
        error: {
          tag: "FolderMissingError",
          message: `The folder ${missingFolder} is missing. It was moved or deleted.`,
        },
      }
    if (method === "attachments.stage")
      return {
        result: { id: "a-1", name: "notes.txt", path: "/tmp/notes.txt", mime: "text/plain", kind: "file", bytes: 1 },
      }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
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
  interruptedAt: null,
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

test("a missing folder shows one Folder missing link to Details instead of its path", async () => {
  const thread = threadWith("folder-missing", "idle")
  await render(<Composer thread={thread} />)

  const notice = page.getByRole("button", { name: "Folder missing", exact: true })
  await expect.element(notice).toBeVisible()
  await expect.element(page.getByText(missingFolder, { exact: false })).not.toBeInTheDocument()

  await notice.click()
  expect(useUi.getState().sidePanelViews[thread.id]).toBe("details")
})

test("a new thread whose project folder is missing still says why commands did not load", async () => {
  const thread = { ...threadWith("folder-missing-draft", "idle"), worktreeId: null }
  useMessages.setState({
    byThread: {
      [thread.id]: {
        status: "ready",
        messages: [],
        approvals: [],
        questions: [],
        secretRequests: [],
        snapshotId: 1,
        missedFinishes: 0,
      },
    },
  })
  await render(<Composer thread={thread} />)

  await expect
    .element(page.getByText("Could not load commands and skills: The folder was moved or deleted."))
    .toBeVisible()
  await expect.element(page.getByText(missingFolder, { exact: false })).not.toBeInTheDocument()
})

test("Folder missing in a side chat opens Details for the thread it belongs to", async () => {
  const thread = { ...threadWith("folder-missing-side", "idle"), sideOf: "main-thread" }
  await render(<Composer thread={thread} />)

  await page.getByRole("button", { name: "Folder missing", exact: true }).click()
  expect(useUi.getState().sidePanelViews["main-thread"]).toBe("details")
})

test("a started thread on the project root keeps the commands line, since Details has no missing hint for it", async () => {
  const thread = { ...threadWith("folder-missing-root", "idle"), worktreeId: null }
  useMessages.setState({
    byThread: {
      [thread.id]: {
        status: "ready",
        messages: [{ role: "user", parts: [] } as unknown as Message],
        approvals: [],
        questions: [],
        secretRequests: [],
        snapshotId: 1,
        missedFinishes: 0,
      },
    },
  })
  await render(<Composer thread={thread} />)

  await expect
    .element(page.getByText("Could not load commands and skills: The folder was moved or deleted."))
    .toBeVisible()
  await expect.element(page.getByRole("button", { name: "Folder missing", exact: true })).not.toBeInTheDocument()
})
