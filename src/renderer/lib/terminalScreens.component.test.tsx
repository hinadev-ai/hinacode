import { expect, test } from "vitest"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { TerminalSession } from "../../shared/domain.ts"
import { attachTerminal, attachTerminalOutput, writeTerminal } from "./terminalScreens.ts"

const osc52 = (text: string) => `\x1b]52;c;${btoa(text)}\x07`

const session: TerminalSession = {
  id: "terminal-1",
  threadId: "thread-1",
  cwd: "/home/studio/web",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  title: null,
  command: null,
  lastExitCode: null,
}

const history = `ssh studio\r\n${osc52("copied before the drawer opened")}history line\r\n`

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "terminal.attach") return { result: { session, offset: 0, data: history } }
    if (method === "terminal.resize" || method === "terminal.write") return { result: undefined }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const copied: Array<string> = []
Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: async (text: string) => {
      copied.push(text)
    },
  },
})

test("a program on a remote pty copies to this machine's clipboard with OSC 52, and replayed output does not", async () => {
  await attachTerminalOutput(session.id)
  const container = document.createElement("div")
  container.style.cssText = "width: 640px; height: 320px; display: flex"
  document.body.append(container)
  attachTerminal(session.id, container)
  await expect.poll(() => container.textContent).toContain("history line")
  expect(copied).toEqual([])

  writeTerminal(session.id, osc52("copied in vim over ssh"), history.length)

  await expect.poll(() => copied).toEqual(["copied in vim over ssh"])
})
