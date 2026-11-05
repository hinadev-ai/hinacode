import { afterEach, expect, test, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { ProviderId } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { MessagePartView, PartMessage } from "./MessagePart.tsx"

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

  await page.getByRole("button", { name: MOVE }).click()

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "backgroundTasks.moveCommand",
      { threadId: "thread-1", callId: "toolu-1" },
      undefined,
    ),
  )
})

test("offers no move once the command finished", async () => {
  await renderCommand("claude", command("done"))
  await expect.element(page.getByRole("button", { name: MOVE })).not.toBeInTheDocument()
})

test("offers no move for an agent that cannot do it", async () => {
  await renderCommand("codex", command("running"))
  await expect.element(page.getByRole("button", { name: MOVE })).not.toBeInTheDocument()
})
