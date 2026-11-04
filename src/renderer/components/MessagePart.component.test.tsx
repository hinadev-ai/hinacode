import { afterEach, expect, test, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { ProviderId } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { MessagePartView, PartMessage, ToolGroup } from "./MessagePart.tsx"

const MOVE = "Move to background"

const command = (status: Extract<MessagePart, { type: "tool_call" }>["status"]): MessagePart => ({
  type: "tool_call",
  callId: "toolu-1",
  name: "Bash",
  input: { command: "pnpm dev" },
  status,
})

const renderCommand = (provider: ProviderId, part: MessagePart) => {
  useThreads.setState({ byId: { "thread-1": { provider } } } as never)
  return render(
    <PartMessage value={{ id: "message-1", threadId: "thread-1" }}>
      <MessagePartView part={part} />
    </PartMessage>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test("moves a running command of a Claude thread to the background", async () => {
  const rpc = vi.fn(() => Promise.resolve({ result: true }))
  vi.stubGlobal("hinacode", { rpc, onEvent: () => () => {} })
  await renderCommand("claude", command("running"))

  for (const animation of document.getAnimations()) {
    if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish()
  }
  await page.getByRole("button", { name: MOVE }).click()

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "backgroundTasks.moveCommand",
      { threadId: "thread-1", callId: "toolu-1" },
      undefined,
    ),
  )
})

test("waits before offering the move, so quick commands stay quiet", async () => {
  vi.stubGlobal("hinacode", { rpc: vi.fn(), onEvent: () => () => {} })
  await renderCommand("claude", command("running"))
  await expect.element(page.getByRole("button", { name: MOVE })).not.toBeInTheDocument()
})

test("puts the description before the command", async () => {
  await renderCommand("codex", {
    type: "tool_call",
    callId: "toolu-2",
    name: "Bash",
    input: { command: "pnpm build", description: "Build for production" },
    status: "done",
  })
  const row = await page.getByRole("button", { name: /Build for production/ }).element()
  expect(row.textContent).toMatch(/Build for production.*pnpm build/)
})

test("names HinaCode's own tools instead of showing the raw id", async () => {
  await renderCommand("claude", {
    type: "tool_call",
    callId: "toolu-3",
    name: "mcp__hinacode__link_pull_request",
    input: { url: "https://github.com/hinadev-ai/hinacode/pull/1" },
    status: "error",
  })
  const row = await page.getByRole("button", { name: /Link pull request/ }).element()
  expect(row.textContent).toContain("https://github.com/hinadev-ai/hinacode/pull/1")
  expect(row.textContent).not.toContain("mcp__")
})

test("offers no move once the command finished", async () => {
  await renderCommand("claude", command("done"))
  await expect.element(page.getByRole("button", { name: MOVE })).not.toBeInTheDocument()
})

test("offers no move for an agent that cannot do it", async () => {
  await renderCommand("codex", command("running"))
  await expect.element(page.getByRole("button", { name: MOVE })).not.toBeInTheDocument()
})

const thinking = { type: "reasoning", text: "Check the login handler first." } as const
const read = (callId: string) =>
  ({ type: "tool_call", callId, name: "Read", input: { file_path: "a.ts" }, status: "done" }) as const

test("keeps the thinking next to a lone tool call", async () => {
  await render(<ToolGroup messageId="m" index={0} parts={[thinking, read("1")]} />)
  await expect.element(page.getByRole("button", { name: /Thinking/ })).toBeVisible()
  await expect.element(page.getByRole("button", { name: /Read/ })).toBeVisible()
})

test("shows the thinking inside an opened tool group", async () => {
  await render(<ToolGroup messageId="m" index={0} parts={[thinking, read("1"), read("2")]} />)
  await page.getByRole("button", { name: /Read 2 files/ }).click()
  await expect.element(page.getByRole("button", { name: /Thinking/ })).toBeVisible()
})

test("gives a file edit the same contrast as a command's description", async () => {
  await renderCommand("claude", {
    type: "tool_call",
    callId: "e",
    name: "Edit",
    input: { file_path: "a.ts" },
    status: "done",
  })
  const name = page.getByText("Edit", { exact: true }).element()
  const root = getComputedStyle(document.documentElement).getPropertyValue("--foreground")
  expect(name.className).toContain("text-foreground")
  expect(root).not.toBe("")
})

test("shows a TodoWrite call as a checklist, not its raw JSON", async () => {
  await renderCommand("claude", {
    type: "tool_call",
    callId: "todo",
    name: "TodoWrite",
    input: {
      todos: [
        { content: "Find the handler", status: "completed", activeForm: "Finding" },
        { content: "Open a pull request", status: "in_progress", activeForm: "Opening" },
      ],
    },
    output: "Todos have been modified successfully.",
    status: "done",
  })
  const row = page.getByRole("button", { name: /Update tasks/ })
  await expect.poll(() => row.element().textContent).toContain("1 of 2 done")
  await row.click()
  await expect.element(page.getByText("Open a pull request")).toBeVisible()
  expect(document.body.textContent).not.toContain("activeForm")
  expect(document.body.textContent).not.toContain("modified successfully")
})
