import { Schema } from "effect"
import { Suspense, useState } from "react"
import { expect, test } from "vitest"
import { cdp, page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings, type TerminalSession } from "../../shared/domain.ts"
import "../index.css"
import { ComposerInput } from "./ComposerInput.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) =>
    method === "clientSettings.get"
      ? { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
      : { error: { tag: "NotStubbed", message: method } },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const placeholder = "Ask anything"

const shownPlaceholder = () => {
  const line = document.querySelector(".cm-line")
  return line === null ? null : getComputedStyle(line, "::before").content
}

let value = ""
let mentionStarts = 0

const terminal = (id: string, title: string | null, status: TerminalSession["status"]): TerminalSession => ({
  id,
  threadId: "thread",
  cwd: `/work/${id}`,
  cols: 80,
  rows: 24,
  status,
  exitCode: status === "exited" ? 1 : null,
  title,
  command: null,
  lastExitCode: null,
})

const terminals = [
  { session: terminal("term-a", null, "running"), label: "Terminal 1" },
  { session: terminal("term-b", "pnpm dev", "exited"), label: "pnpm dev" },
]

function Harness({ placeholder: shown = placeholder }: { placeholder?: string }) {
  const [text, setText] = useState("")
  return (
    <ComposerInput
      value={text}
      onValueChange={(next) => {
        value = next
        setText(next)
      }}
      commands={[]}
      files={[]}
      onMentionStart={() => {
        mentionStarts += 1
      }}
      threads={{ sameMachine: [], otherMachines: [] }}
      terminals={terminals}
      artifacts={[]}
      projectId="project"
      placeholder={shown}
      aria-label="Message"
      onEnter={() => {}}
    />
  )
}

const renderComposer = () =>
  render(
    <Suspense>
      <Harness />
    </Suspense>,
  )

const type = (text: string) => cdp().send("Input.insertText", { text })

const press = async (key: "Enter" | "Backspace" | "Tab", modifiers = 0) => {
  const code = { Enter: 13, Backspace: 8, Tab: 9 }[key]
  const event = { key, code: key, windowsVirtualKeyCode: code, modifiers }
  await cdp().send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event })
  await cdp().send("Input.dispatchKeyEvent", { type: "keyUp", ...event })
}
const shift = 8

test("reports a mention when it starts, not on each key typed in it", async () => {
  mentionStarts = 0
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()
  await type("@")
  await expect.poll(() => mentionStarts).toBe(1)
  await type("r")
  await type("e")
  await expect.poll(() => value).toBe("@re")
  await type(" @")
  await expect.poll(() => mentionStarts).toBe(2)
})

test("continues a list on shift+enter and leaves it on an empty item", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("1. first")
  await press("Enter", shift)
  await type("second")
  await press("Enter", shift)
  await expect.poll(() => value).toBe("1. first\n2. second\n3. ")

  await press("Enter", shift)
  await type("- dot")
  await press("Enter", shift)
  await expect.poll(() => value).toBe("1. first\n2. second\n- dot\n- ")
  await expect.poll(() => document.querySelectorAll(".cm-line")[3]?.textContent).toBe("• ")

  await press("Backspace")
  await expect.poll(() => value).toBe("1. first\n2. second\n- dot\n")
})

test("indents a list item on tab and keeps the focus in the composer", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("1. first")
  await press("Enter", shift)
  await type("second")
  await press("Tab")
  await expect.poll(() => value).toBe("1. first\n   1. second")
  expect(document.activeElement).toBe(document.querySelector(".cm-content"))

  await press("Tab", shift)
  await expect.poll(() => value).toBe("1. first\n2. second")
})

test("ignores the separate char event a DevTools screencast sends after Enter", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("- 123")
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: shift }
  await cdp().send("Input.dispatchKeyEvent", { type: "keyDown", ...enter })
  await cdp().send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...enter })
  await cdp().send("Input.dispatchKeyEvent", { type: "keyUp", ...enter })
  await type("456")
  await expect.poll(() => value).toBe("- 123\n- 456")
})

test("keeps a long placeholder on one line instead of scrolling", async () => {
  await render(
    <Suspense>
      <div style={{ width: 240 }}>
        <Harness placeholder="Ask anything. Type @ to mention a file or thread, / to run a skill." />
      </div>
    </Suspense>,
  )
  await page.getByRole("combobox", { name: "Message" }).click()
  await expect.poll(shownPlaceholder).toContain("Ask anything")

  const scroller = document.querySelector<HTMLElement>(".cm-scroller")!
  expect(scroller.scrollHeight).toBe(scroller.clientHeight)
  expect(scroller.scrollWidth).toBe(scroller.clientWidth)
})

test("hides the placeholder while an IME composes the first character", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()
  await expect.poll(shownPlaceholder).toBe(`"${placeholder}"`)

  await cdp().send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 })
  await expect.poll(shownPlaceholder).toBe("none")
})

test("suggests the thread's terminals for @ and inserts the picked one as a mention", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("look at @")
  const mentions = page.getByRole("listbox", { name: "Mentions" })
  await expect.element(mentions.getByRole("option").nth(0)).toHaveTextContent("Terminal 1/work/term-a")
  await expect.element(mentions.getByRole("option").nth(1)).toHaveTextContent("pnpm dev/work/term-bexited")

  await type("dev")
  await expect.element(mentions.getByRole("option")).toHaveTextContent("pnpm dev/work/term-bexited")
  await press("Enter")
  await expect.poll(() => value).toBe("look at @terminal:term-b ")
  await expect
    .poll(() => [...document.querySelectorAll(".cm-line .text-syntax-token")].map((mark) => mark.textContent))
    .toStrictEqual(["@terminal:term-b"])
})

const paste = (data: Record<string, string>) => {
  const clipboardData = new DataTransfer()
  for (const [format, text] of Object.entries(data)) clipboardData.setData(format, text)
  document
    .querySelector(".cm-content")!
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
}

test("pastes a formatted web page as markdown", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  paste({
    "text/plain": "Setup\nRun the dev server.\nSee docs",
    "text/html": `<meta charset="utf-8"><h2>Setup</h2><ul><li>Run <code>pnpm dev</code><ol start="3"><li>nested</li><li>again</li></ol></li></ul><p>See <a href="https://example.com/docs">docs</a></p><pre><code class="language-sh">pnpm build</code></pre>`,
  })

  await expect
    .poll(() => value)
    .toBe(
      "## Setup\n\n- Run `pnpm dev`\n  3. nested\n  4. again\n\nSee [docs](https://example.com/docs)\n\n```sh\npnpm build\n```",
    )
})

test("pastes styled editor text as it was typed", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  paste({
    "text/plain": "const a_b = 1 * 2",
    "text/html": `<div style="color: #ccc"><div><span style="color: #569cd6">const</span><span> a_b = 1 * 2</span></div></div>`,
  })

  await expect.poll(() => value).toBe("const a_b = 1 * 2")
})

test("unwraps the bold wrapper Google Docs puts around a copy", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  paste({
    "text/plain": "Plan\nShip it",
    "text/html": `<b style="font-weight:normal;" id="docs-internal-guid-1"><h1><span>Plan</span></h1><p><span>Ship </span><a href="https://example.com">it</a></p></b>`,
  })

  await expect.poll(() => value).toBe("# Plan\n\nShip [it](https://example.com)")
})
