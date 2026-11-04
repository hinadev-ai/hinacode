import { Schema } from "effect"
import { beforeEach, expect, onTestFinished, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { Artifact, DocumentSaveResult } from "../../../shared/artifact.ts"
import { type HinacodeBridge, type PushEvent, RpcMethods } from "../../../shared/contract.ts"
import { defaultClientSettings, type Thread } from "../../../shared/domain.ts"
import "../../index.css"
import { useArtifacts } from "../../stores/artifacts.ts"
import { useDrafts } from "../../stores/drafts.ts"
import { ArtifactsHeader, ArtifactsView } from "../sidePanel/ArtifactsView.tsx"

const AGENT_MARKDOWN = `# Release plan

Ship the **editor** first.

- [x] Write the design
- [ ] Build it

| Step | Owner |
| --- | --- |
| Store | Agent |

\`\`\`ts
const version = 1
\`\`\`
`

let documentId = "plan-0"
let title = "Release plan"
let renames: Array<string> = []
let finishRename: () => void = () => {}

const documentAt = (version: number, revision = version): Artifact => ({
  id: documentId,
  kind: "document",
  title,
  entry: "document.md",
  version,
  revision,
  files: [{ path: "document.md", type: "text/markdown; charset=utf-8", size: 10 }],
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: `2026-11-03T00:0${version}:00.000Z`,
  threadId: "t-1",
})

let stored = { version: 1, revision: 1, markdown: AGENT_MARKDOWN }
let nextSave: DocumentSaveResult | undefined
let saves: Array<{ baseRevision: number; markdown: string }> = []
const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "artifacts.list") return { result: [documentAt(stored.version, stored.revision)] }
    if (method === "artifacts.readDocument") return { result: stored }
    if (method === "artifacts.saveDocument") {
      const save = payload as { baseRevision: number; markdown: string }
      saves.push(save)
      if (nextSave !== undefined) return { result: nextSave }
      stored = { version: 2, revision: stored.revision + 1, markdown: save.markdown }
      return { result: { type: "saved", version: stored.version, revision: stored.revision } }
    }
    if (method === "artifacts.rename") {
      renames.push((payload as { title: string }).title)
      await new Promise<void>((resolve) => {
        finishRename = resolve
      })
      title = (payload as { title: string }).title
      const renamed = documentAt(stored.version, stored.revision)
      push({ type: "artifact.updated", artifact: renamed })
      return { result: renamed }
    }
    if (method === "environments.list") return { result: { clouds: [] } }
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  pathForFile: () => "",
  liquidGlass: false,
}
Object.defineProperty(window, "hinacode", { value: bridge })

const thread = { id: "t-1" } as Thread

const push = (event: typeof PushEvent.Encoded) => {
  for (const listener of listeners) listener(event)
}

beforeEach(({ task }) => {
  documentId = `plan-${task.id}`
  title = "Release plan"
  renames = []
  stored = { version: 1, revision: 1, markdown: AGENT_MARKDOWN }
  nextSave = undefined
  saves = []
  useArtifacts.getState().select(thread.id, documentId)
  push({ type: "artifact.updated", artifact: documentAt(1) })
})

const openDocument = async (width?: number) => {
  await render(
    <div style={{ width, height: 600, display: "flex", flexDirection: "column" }}>
      <ArtifactsHeader thread={thread} />
      <ArtifactsView thread={thread} />
    </div>,
  )
  const editor = page.getByRole("textbox", { name: "Release plan" })
  await expect.element(editor.getByRole("heading", { name: "Release plan" })).toBeInTheDocument()
  return editor
}

const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control"
const withMod = (event: KeyboardEvent) => (mod === "Meta" ? event.metaKey : event.ctrlKey)

const typeAtEnd = async (text: string) => {
  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard("{End}")
  await userEvent.keyboard(text)
}

test("edits an agent's document and saves Markdown that keeps every block the agent wrote", async () => {
  const editor = await openDocument()
  await expect.element(editor.getByRole("cell", { name: "Store" })).toBeInTheDocument()
  expect(saves).toEqual([])

  await typeAtEnd(" Then the panel.")

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  const [saved] = saves
  expect(saved?.baseRevision).toBe(1)
  expect(saved?.markdown).toContain("Ship the **editor** first. Then the panel.")
  expect(saved?.markdown).toMatch(/- \[x\] Write the design/)
  expect(saved?.markdown).toMatch(/- \[ \] Build it/)
  expect(saved?.markdown).toMatch(/\|\s*Step\s*\|\s*Owner\s*\|/)
  expect(saved?.markdown).toContain("```ts\nconst version = 1\n```")
  await expect.element(page.getByText("Saved", { exact: true })).toBeInTheDocument()
})

test("loads an agent's new version when there are no unsaved edits", async () => {
  const editor = await openDocument()
  stored = { version: 2, revision: 2, markdown: "# Release plan\n\nThe agent rewrote this.\n" }
  push({ type: "artifact.updated", artifact: documentAt(2) })

  await expect.element(editor.getByText("The agent rewrote this.")).toBeInTheDocument()
  expect(saves).toEqual([])
})

test("offers to keep the developer's edits or take the agent's when a save conflicts", async () => {
  const editor = await openDocument()
  nextSave = { type: "conflict", version: 2, revision: 2, markdown: "# Release plan\n\nThe agent's version.\n" }
  await typeAtEnd(" Mine.")

  const alert = page.getByRole("alert")
  await expect.element(alert.getByText("The agent changed this document while you were editing.")).toBeVisible()
  await alert.getByRole("button", { name: "Keep mine" }).click()
  await expect.poll(() => saves.at(-1)?.baseRevision).toBe(2)

  await typeAtEnd(" Again.")
  await expect.element(alert).toBeInTheDocument()
  nextSave = undefined
  await alert.getByRole("button", { name: "Use theirs" }).click()
  await expect.element(editor.getByText("The agent's version.")).toBeInTheDocument()
  await expect.element(alert).not.toBeInTheDocument()
})

test("asks the agent to read the edited document from the thread's draft", async () => {
  await openDocument()
  await page.getByRole("button", { name: "Ask agent" }).click()

  expect(useDrafts.getState().byThreadId[thread.id]?.text).toContain(`"Release plan" (${documentId}, revision 1)`)
})

test("colors a code block in the language the Markdown names", async () => {
  const editor = await openDocument()
  const block = editor.element().querySelector("pre")!

  await expect.poll(() => block.querySelectorAll("span[style*='color']").length, { timeout: 10_000 }).toBeGreaterThan(1)
  expect(block.textContent).toBe("const version = 1")
  expect(saves).toEqual([])
})

test("deletes a table from the menu on the table and saves the document without it", async () => {
  const editor = await openDocument()
  await editor.getByRole("cell", { name: "Store" }).click()
  await page.getByRole("button", { name: "Delete table" }).click()

  await expect.element(editor.getByRole("table")).not.toBeInTheDocument()
  await expect.poll(() => saves.at(-1)?.markdown, { timeout: 3000 }).not.toMatch(/\|\s*Step\s*\|/)
})

test("keeps the editor's own shortcuts from reaching the app's", async () => {
  await openDocument()
  const reached: Array<string> = []
  const listener = (event: KeyboardEvent) => {
    if (withMod(event) && event.key !== mod) reached.push(event.key)
  }
  document.addEventListener("keydown", listener)
  onTestFinished(() => document.removeEventListener("keydown", listener))

  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard(`{${mod}>}b{/${mod}}`)
  await userEvent.keyboard(`{${mod}>}p{/${mod}}`)

  expect(reached).toEqual(["p"])
})

test("changes a code block's language after it was written", async () => {
  await openDocument()
  const picker = page.getByRole("combobox", { name: "Code language" })
  await expect.element(picker).toHaveTextContent("TypeScript")

  await picker.click()
  await page.getByRole("option", { name: "Python" }).click()

  await expect.element(picker).toHaveTextContent("Python")
  await expect
    .poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 })
    .toContain("```python\nconst version = 1\n```")
})

test("shows a link's card on hover, not while the caret moves through it", async () => {
  stored = { ...stored, markdown: "# Release plan\n\nRead [the design](https://hinacode.dev/design) first.\n" }
  const editor = await openDocument()
  const link = editor.getByRole("link")

  await page.getByText(/^Read/).click()
  await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
  await userEvent.keyboard("x")
  await expect.element(page.getByRole("button", { name: "Edit link" })).not.toBeInTheDocument()

  await link.hover()
  await page.getByRole("button", { name: "Edit link" }).click()
  const text = page.getByRole("textbox", { name: "Text", exact: true })
  await expect
    .element(page.getByRole("textbox", { name: "Link", exact: true }))
    .toHaveValue("https://hinacode.dev/design")
  await text.fill("the spec")
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("hinacode.dev/spec")
  await userEvent.keyboard("{Enter}")

  await expect
    .poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 })
    .toContain("Read [the spec](https://hinacode.dev/spec) first.")
})

test("links the selected text with Cmd+K", async () => {
  await openDocument()
  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard("{End}{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}")
  await userEvent.keyboard(`{${mod}>}k{/${mod}}`)

  const address = page.getByRole("textbox", { name: "Link", exact: true })
  await expect.element(address).toHaveFocus()
  await expect.element(page.getByRole("textbox", { name: "Text", exact: true })).toHaveValue("first.")
  await userEvent.keyboard("hinacode.dev{Enter}")

  await expect
    .poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 })
    .toContain("Ship the **editor** [first.](https://hinacode.dev)")
})

test("renames the document from the panel header once, showing the new name while it saves", async () => {
  await openDocument()
  const field = page.getByRole("textbox", { name: "New name for Release plan" })

  await page.getByRole("button", { name: "Release plan", exact: true }).click()
  await field.fill("Discarded")
  await userEvent.keyboard("{Escape}")
  await expect.element(field).not.toBeInTheDocument()

  await page.getByRole("button", { name: "Release plan", exact: true }).click()
  await field.fill("Launch plan")
  await userEvent.keyboard("{Enter}")

  const renamed = page.getByRole("button", { name: "Launch plan", exact: true })
  await expect.element(renamed).toBeInTheDocument()
  await expect.element(field).not.toBeInTheDocument()
  await page.getByRole("textbox", { name: "Release plan" }).click()
  finishRename()

  await expect.element(renamed).toBeInTheDocument()
  expect(renames).toEqual(["Launch plan"])
})

const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

const firstLineRects = (element: Element) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const rects: Array<DOMRect> = []
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    const range = document.createRange()
    range.selectNodeContents(text)
    rects.push(...range.getClientRects())
  }
  const top = rects[0]?.top ?? 0
  return rects.filter((rect) => Math.abs(rect.top - top) < 2)
}

for (const width of [360, 700]) {
  test(`keeps the language picker off the first line of code in a ${width}px panel`, async () => {
    stored = {
      ...stored,
      markdown:
        '# Release plan\n\n```ts\ntype ArtifactKind = "page" | "document" | "chart" | "diagram" | "callout" | "table"\n```\n',
    }
    const editor = await openDocument(width)
    const picker = page.getByRole("combobox", { name: "Code language" })
    await expect.element(picker).toBeVisible()

    const box = picker.element().getBoundingClientRect()
    const line = firstLineRects(editor.element().querySelector("pre code")!)
    expect(line.length).toBeGreaterThan(0)
    expect(line.filter((rect) => intersects(rect, box))).toEqual([])
  })
}

const CALLOUTS = `> [!NOTE]
> First paragraph.
>
> Second paragraph.

> [!tip]
> Prefer the smaller change.

> [!IMPORTANT]
> Read the **design** first.

> [!WARNING]
> - The store rewrites the file
> - Saves race

> [!CAUTION]
> Deleting a document cannot be undone.`

const savedAfterEdit = async (markdown: string) => {
  stored = { ...stored, markdown: `# Release plan\n\nShip the **editor** first.\n\n${markdown}\n` }
  const editor = await openDocument()
  await typeAtEnd(" Then the panel.")
  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  return { editor, saved: saves[0]?.markdown ?? "" }
}

test("reads GitHub alerts as callouts and writes them back in GitHub's form", async () => {
  const { editor, saved } = await savedAfterEdit(CALLOUTS)

  const labels = Array.from(editor.element().querySelectorAll("[data-callout-label]"), (label) => label.textContent)
  expect(labels).toEqual(["Note", "Tip", "Important", "Warning", "Caution"])
  expect(editor.element().querySelector("blockquote")).toBeNull()
  expect(saved).toContain(CALLOUTS.replace("[!tip]", "[!TIP]"))
})

test("keeps a plain quote, and a marker with text after it, as quotes", async () => {
  const { editor, saved } = await savedAfterEdit("> Just a quote.\n\n> [!NOTE] Not on its own line.")

  expect(editor.element().querySelectorAll("blockquote")).toHaveLength(2)
  expect(editor.element().querySelector("[data-callout]")).toBeNull()
  expect(saved).toMatch(/> Just a quote\.\n\n> \\?\[!NOTE\\?\] Not on its own line\./)
})

test("wraps a paragraph in a callout from the toolbar, then changes its type and turns it back into a quote", async () => {
  const editor = await openDocument()
  await page.getByText(/^Ship the/).click()
  await page.getByRole("button", { name: "Callout", exact: true }).click()

  const picker = editor.getByRole("button", { name: "Callout type: Note" })
  await expect.element(picker).toBeVisible()
  await expect
    .poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 })
    .toContain("> [!NOTE]\n> Ship the **editor** first.")

  await picker.click()
  await page.getByRole("menuitemradio", { name: "Warning" }).click()
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument()
  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toContain("> [!WARNING]\n> Ship the")

  await editor.getByRole("button", { name: "Callout type: Warning" }).click()
  await page.getByRole("menuitem", { name: "Quote" }).click()
  await expect.element(editor.getByRole("button", { name: /^Callout type/ })).not.toBeInTheDocument()
  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).not.toContain("[!")
  expect(saves.at(-1)?.markdown).toContain("# Release plan\n\n> Ship the **editor** first.")
  await expect.element(editor.getByRole("blockquote")).toHaveTextContent("Ship the editor first.")
})

const FLOWCHART =
  "```mermaid\nflowchart TD\n  Agent[Agent publishes] --> Editor[Developer edits]\n  Editor --> Agent\n```"

test("draws a mermaid block as a diagram and saves its fence unchanged", async () => {
  const { editor, saved } = await savedAfterEdit(FLOWCHART)

  await expect.poll(() => editor.element().querySelector("[data-diagram-svg] > svg"), { timeout: 10_000 }).not.toBeNull()
  expect(editor.element().querySelector("[data-diagram-svg] > svg")?.textContent).toContain("Developer edits")
  await expect.element(page.getByRole("combobox", { name: "Code language" })).not.toBeInTheDocument()
  expect(saved).toContain(FLOWCHART)
})

test("shows the error and the source of a diagram that cannot be drawn", async () => {
  stored = { ...stored, markdown: "# Release plan\n\n```mermaid\nflowchart TD\n  A -->\n```\n" }
  const editor = await openDocument()

  await expect
    .poll(() => editor.element().querySelector("[role=alert]")?.textContent ?? "", { timeout: 10_000 })
    .toMatch(/^This diagram cannot be drawn: \S/)
  await expect.element(page.getByRole("combobox", { name: "Code language" })).toHaveTextContent("Diagram")
  await expect.element(editor.getByRole("code")).toBeVisible()
  expect(editor.getByRole("code").element().textContent).toBe("flowchart TD\n  A -->")
  await expect.element(editor.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true")
})
