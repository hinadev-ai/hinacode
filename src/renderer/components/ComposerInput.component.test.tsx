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

const press = async (key: "Enter" | "Backspace" | "Tab" | "Home" | "ArrowLeft", modifiers = 0) => {
  const code = { Enter: 13, Backspace: 8, Tab: 9, Home: 36, ArrowLeft: 37 }[key]
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

const dot = (line: Element) => line.querySelector(".cm-list-marker span")!.getBoundingClientRect()

const textStarts = (line: Element) => {
  const range = document.createRange()
  range.setStartAfter(line.querySelector(".cm-list-marker")!)
  range.setEndAfter(line.lastChild!)
  const starts = new Map<number, number>()
  for (const box of range.getClientRects()) {
    const top = Math.round(box.top)
    starts.set(top, Math.min(starts.get(top) ?? Infinity, Math.round(box.left)))
  }
  return [...new Set(starts.values())]
}

test("indents a list item and keeps its wrapped text under its first word", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  const long = "wrapped words ".repeat(40)
  await type("plain")
  await press("Enter", shift)
  await type(`- ${long}`)
  await press("Enter", shift)
  await press("Tab")
  await type(long)
  await expect.poll(() => value).toBe(`plain\n- ${long}\n  - ${long}`)

  const [plain, item, nested] = [...document.querySelectorAll(".cm-line")]
  expect(item!.getBoundingClientRect().height).toBeGreaterThan(plain!.getBoundingClientRect().height)
  expect(dot(item!).left).toBeGreaterThan(plain!.getBoundingClientRect().left + 4)
  expect(textStarts(item!)).toHaveLength(1)
  expect(textStarts(nested!)).toHaveLength(1)
  expect(dot(nested!).left).toBeGreaterThan(textStarts(item!)[0]!)
})

test("draws a line that starts with > as a quote and continues it on shift+enter", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("> quoted")
  await expect.poll(() => value).toBe("> quoted")
  const line = document.querySelector(".cm-line")!
  expect(line.textContent).toBe("quoted")
  expect(Number.parseFloat(getComputedStyle(line).borderInlineStartWidth)).toBeGreaterThan(0)

  await press("Enter", shift)
  await type("more")
  await press("Enter", shift)
  await expect.poll(() => value).toBe("> quoted\n> more\n> ")

  await press("Enter", shift)
  await expect.poll(() => value).toBe("> quoted\n> more\n")

  await type("> ")
  await press("Backspace")
  await expect.poll(() => value).toBe("> quoted\n> more\n")
})

test("sets inline code and code blocks in the monospace font", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("extract the `state`")
  await press("Enter", shift)
  await type("```ts")
  await press("Enter", shift)
  await type("const actor")
  await expect.poll(() => value).toBe("extract the `state`\n```ts\nconst actor")

  const mono = getComputedStyle(document.documentElement).getPropertyValue("--app-font-mono").trim()
  const [prose, fenceOpen, fenceCode] = [...document.querySelectorAll<HTMLElement>(".cm-line")]
  const inlineCode = [...prose!.querySelectorAll("span")].find((span) => span.textContent === "`state`")!
  expect(getComputedStyle(prose!).fontFamily).not.toBe(mono)
  expect(getComputedStyle(inlineCode).fontFamily).toBe(mono)
  expect(getComputedStyle(fenceOpen!).fontFamily).toBe(mono)
  expect(getComputedStyle(fenceCode!).fontFamily).toBe(mono)
})

test("removes only the marker of a quote on backspace", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type(">  indented")
  await press("Home")
  await press("Backspace")
  await expect.poll(() => value).toBe(" indented")
})

test("never rests the caret before a quote's hidden marker", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("plain")
  await press("Enter", shift)
  await type("> quoted")
  await press("Home")
  await press("Home")
  await type("still ")
  await expect.poll(() => value).toBe("plain\n> still quoted")

  await press("Home")
  await press("ArrowLeft")
  await type("!")
  await expect.poll(() => value).toBe("plain!\n> still quoted")
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

test("pastes a formatted web page as text that keeps only its inline formats", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  paste({
    "text/plain": "Setup\nRun the dev server.\nSee docs",
    "text/html": `<meta charset="utf-8"><h2>Setup <em>now</em></h2><ul><li>Run <code>pnpm dev</code><ol start="3"><li><strong>nested</strong></li><li>snake_case * 2</li></ol></li></ul><blockquote><p>See <a href="https://example.com/docs">docs</a>, <del>later</del><br>or not</p></blockquote><hr><img src="https://example.com/a.png" alt="shot"><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code class="language-sh">pnpm build\n  --watch</code></pre>`,
  })

  await expect
    .poll(() => value)
    .toBe(
      "Setup *now*\n\nRun `pnpm dev`\n**nested**\nsnake_case * 2\n\nSee docs, ~~later~~\nor not\n\na\tb\n1\t2\n\npnpm build\n  --watch",
    )
})

test("keeps the indentation of pasted code and the blank line two breaks make", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  paste({
    "text/plain": "first\nsecond\ndone\n\nafter",
    "text/html": `<ul><li><pre><code>  first\n    second</code></pre></li></ul><p><b>done</b><br><br>after</p>`,
  })

  await expect.poll(() => value).toBe("  first\n    second\n\n**done**\n\nafter")
})

test("pastes a web page without inline formats as its plain text", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  paste({
    "text/plain": "Setup\nRun the dev server.\npnpm build",
    "text/html": `<meta charset="utf-8"><h2>Setup</h2><ul><li>Run the <a href="https://example.com">dev server</a>.</li></ul><pre><code>pnpm build</code></pre>`,
  })

  await expect.poll(() => value).toBe("Setup\nRun the dev server.\npnpm build")
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
    "text/html": `<b style="font-weight:normal;" id="docs-internal-guid-1"><h1><span>Plan</span></h1><p><span>Ship </span><a href="https://example.com">it</a> <i>soon</i></p></b>`,
  })

  await expect.poll(() => value).toBe("Plan\n\nShip it *soon*")
})
