import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { TerminalSession } from "../../shared/domain.ts"
import "../index.css"
import { useTerminals } from "../stores/terminals.ts"
import { TerminalDrawer } from "./TerminalDrawer.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) => ({ error: { tag: "NotStubbed", message: method } }),
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const session = (index: number): TerminalSession => ({
  id: `terminal-${index}`,
  threadId: "thread-1",
  cwd: "/home/studio/web",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  title: null,
  command: null,
  lastExitCode: null,
})

test("the terminal tabs scroll sideways without drawing a scrollbar under them", async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => session(index))
  useTerminals.setState({
    byThreadId: { "thread-1": { sessions, activeId: sessions[0]!.id, open: true } },
  })
  await render(
    <div className="flex h-96 w-80 flex-col">
      <TerminalDrawer threadId="thread-1" />
    </div>,
  )

  await expect.element(page.getByRole("tab").first()).toBeVisible()
  const list = page.getByRole("tablist").element() as HTMLElement
  expect(list.scrollWidth).toBeGreaterThan(list.clientWidth)
  expect(getComputedStyle(list).scrollbarWidth).toBe("none")
})
