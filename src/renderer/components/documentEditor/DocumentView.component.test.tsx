import { Schema } from "effect"
import { beforeEach, expect, onTestFinished, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { toast } from "sonner"
import { cleanup, render } from "vitest-browser-react"
import type { Artifact, ArtifactComment, ArtifactFeedback, DocumentSaveResult } from "../../../shared/artifact.ts"
import { type HinacodeBridge, type PushEvent, RpcMethods } from "../../../shared/contract.ts"
import { defaultClientSettings, type Thread } from "../../../shared/domain.ts"
import { artifactUrl } from "../../../shared/channels.ts"
import { documentPrintHtml } from "../../../shared/documentPrint.ts"
import "../../index.css"
import { useArtifacts } from "../../stores/artifacts.ts"
import { useDrafts } from "../../stores/drafts.ts"
import { ArtifactsHeader, ArtifactsView } from "../sidePanel/ArtifactsView.tsx"
import { liveDocument, liveDocumentKey } from "./liveDocuments.ts"

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
let saveReleased: Promise<void> = Promise.resolve()
let saves: Array<{ baseRevision: number; markdown: string }> = []
let storedImages: Array<string> = []
let fileReads: Array<{ id: string; path: string }> = []
let imageStored: Promise<void> = Promise.resolve()
let feedback: ArtifactFeedback = { comments: [] }
let commented: Array<unknown> = []
const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()

const agentComment = (id: string, quote: string, prefix: string, body: string): ArtifactComment => ({
  id,
  anchor: { kind: "text", quote, prefix, suffix: "" },
  resolved: false,
  messages: [{ id: `m-${id}`, author: { kind: "agent" }, body, createdAt: "2026-11-08T00:00:00.000Z" }],
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
})

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "artifacts.list") return { result: [documentAt(stored.version, stored.revision)] }
    if (method === "artifacts.readDocument") return { result: stored }
    if (method === "artifacts.saveDocument") {
      const save = payload as { baseRevision: number; markdown: string }
      await saveReleased
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
    if (method === "artifacts.addDocumentImage") {
      storedImages.push((payload as { dataUrl: string }).dataUrl)
      await imageStored
      return { result: { path: "images/pasted.png" } }
    }
    if (method === "artifacts.file") {
      const read = payload as { id: string; path: string }
      fileReads.push(read)
      return {
        result: { dataUrl: read.id === documentId ? (storedImages.at(-1) ?? "") : "data:image/png;base64,b3RoZXI=" },
      }
    }
    if (method === "artifacts.feedback") return { result: feedback }
    if (method === "artifacts.comment") {
      const request = payload as { anchor: ArtifactComment["anchor"]; body: string }
      commented.push(payload)
      feedback = {
        ...feedback,
        comments: [
          ...feedback.comments,
          {
            id: `c-${commented.length}`,
            anchor: request.anchor,
            resolved: false,
            messages: [
              { id: "m-1", author: { kind: "developer" }, body: request.body, createdAt: "2026-11-08T00:00:00.000Z" },
            ],
            createdAt: "2026-11-08T00:00:00.000Z",
            updatedAt: "2026-11-08T00:00:00.000Z",
          },
        ],
      }
      return { result: feedback }
    }
    if (method === "projects.list") return { result: [] }
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
  runtime: { kind: "desktop" },
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
  saveReleased = Promise.resolve()
  saves = []
  storedImages = []
  fileReads = []
  imageStored = Promise.resolve()
  feedback = { comments: [] }
  commented = []
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

const PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
)

const pasteAtEnd = async (fill: (data: DataTransfer) => void) => {
  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard("{End}")
  const clipboardData = new DataTransfer()
  fill(clipboardData)
  document
    .querySelector(".hina-document")!
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
}

test("renders pasted Markdown text as blocks", async () => {
  const editor = await openDocument()

  await pasteAtEnd((data) => data.setData("text/plain", "## Risks\n\n- Saves **race**"))

  await expect.element(editor.getByRole("heading", { name: "Risks" })).toBeInTheDocument()
  await expect.element(editor.getByRole("listitem").filter({ hasText: "Saves race" })).toBeInTheDocument()
  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toMatch(/## Risks\n\n- Saves \*\*race\*\*/)
})

test("pastes text without Markdown syntax as written", async () => {
  await openDocument()

  await pasteAtEnd((data) => data.setData("text/plain", " a_b_c"))

  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toContain("first. a\\_b\\_c")
})

test("stores a pasted image with the document and inlines it when printed", async () => {
  const editor = await openDocument()

  await pasteAtEnd((data) => data.items.add(new File([PIXEL_PNG], "shot.png", { type: "image/png" })))

  await expect.poll(() => storedImages).toEqual([expect.stringMatching(/^data:image\/png;base64,/)])
  await expect
    .poll(() => editor.element().querySelector("img")?.getAttribute("src"))
    .toBe(artifactUrl(documentId, "images/pasted.png"))
  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toContain("![](images/pasted.png)")

  const print = await printed(await liveDocument(liveDocumentKey(undefined, documentId))!.html())
  expect(print.querySelector("img")?.getAttribute("src")).toBe(storedImages[0])
})

test("puts a pasted image where it was pasted, even if the selection changes while it is stored", async () => {
  const editor = await openDocument()
  let finishStoring = () => {}
  imageStored = new Promise((resolve) => {
    finishStoring = resolve
  })

  await pasteAtEnd((data) => data.items.add(new File([PIXEL_PNG], "shot.png", { type: "image/png" })))
  await expect.poll(() => storedImages.length).toBe(1)
  await editor.getByRole("heading", { name: "Release plan" }).click()
  await userEvent.keyboard("{End}{Shift>}{Home}{/Shift}")
  finishStoring()

  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toContain("first.\n\n![](images/pasted.png)")
  expect(saves.at(-1)?.markdown).toMatch(/^# Release plan\n/)
  await expect.element(editor.getByRole("heading", { name: "Release plan" })).toBeInTheDocument()
})

test("keeps the selected text when a pasted image cannot be stored", async () => {
  const editor = await openDocument()
  imageStored = Promise.reject(new Error("disk full"))
  imageStored.catch(() => {})

  await editor.getByRole("heading", { name: "Release plan" }).click()
  await userEvent.keyboard("{End}{Shift>}{Home}{/Shift}")
  const clipboardData = new DataTransfer()
  clipboardData.items.add(new File([PIXEL_PNG], "shot.png", { type: "image/png" }))
  document
    .querySelector(".hina-document")!
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))

  await expect
    .poll(() => toast.getHistory().map((shown) => ("title" in shown ? String(shown.title) : "")))
    .toContainEqual(expect.stringContaining("disk full"))
  await expect.element(editor.getByRole("heading", { name: "Release plan" })).toBeInTheDocument()
  expect(saves).toEqual([])
})

test("copies the bytes of an image pasted from another document", async () => {
  await openDocument()

  await pasteAtEnd((data) =>
    data.setData(
      "text/html",
      '<p data-pm-slice="1 1 []"><img src="images/other.png" alt="" data-artifact-id="other-doc"></p>',
    ),
  )

  await expect.poll(() => fileReads).toContainEqual({ id: "other-doc", path: "images/other.png" })
  await expect.poll(() => storedImages).toEqual(["data:image/png;base64,b3RoZXI="])
  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toContain("![](images/pasted.png)")
})

test("pastes the text of a copy from another document into a code block", async () => {
  await openDocument()

  await page.getByText("const version = 1").click()
  await userEvent.keyboard("{End}")
  const clipboardData = new DataTransfer()
  clipboardData.setData("text/plain", " + 1")
  clipboardData.setData(
    "text/html",
    '<p data-pm-slice="1 1 []">+ 1<img src="images/other.png" alt="" data-artifact-id="other-doc"></p>',
  )
  document
    .querySelector(".hina-document")!
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))

  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toContain("const version = 1 + 1\n```")
  expect(fileReads).toEqual([])
})

test("pastes Markdown syntax literally with Shift held", async () => {
  const editor = await openDocument()

  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard("{End}{Shift>}")
  const clipboardData = new DataTransfer()
  clipboardData.setData("text/plain", "## Keep this literal")
  document
    .querySelector(".hina-document")!
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
  await userEvent.keyboard("{/Shift}")

  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).toContain("Keep this literal")
  await expect.element(editor.getByRole("heading", { name: "Keep this literal" })).not.toBeInTheDocument()
})

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

test("saves the edits of a document closed again while its first close is still saving", async () => {
  let releaseSave: () => void = () => {}
  saveReleased = new Promise((resolve) => {
    releaseSave = resolve
  })
  await openDocument()
  await typeAtEnd(" First.")
  await cleanup()

  await openDocument()
  await typeAtEnd(" Second.")
  const secondEditor = document.querySelector(".hina-document")!
  expect(secondEditor).toHaveProperty("editor")
  await cleanup()
  await expect.poll(() => "editor" in secondEditor).toBe(false)
  releaseSave()

  await expect.poll(() => saves.length).toBe(2)
  expect(saves[1]?.baseRevision).toBe(2)
  expect(saves[1]?.markdown).toContain("Ship the **editor** first. First. Second.")
})

test("comments on the selected text with its quote and context, then highlights it", async () => {
  const editor = await openDocument()
  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard("{End}{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}")

  await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Comment" }).click()
  const input = page.getByRole("combobox", { name: "New comment" })
  await expect.element(input).toHaveFocus()
  await userEvent.keyboard("Should this ship second?{Enter}")

  await expect
    .poll(() => commented)
    .toEqual([
      {
        id: documentId,
        body: "Should this ship second?",
        anchor: {
          kind: "text",
          quote: "first.",
          prefix: "Release plan\nShip the editor ",
          suffix: expect.stringMatching(/^\nWrite the design\nBuild it/),
        },
      },
    ])
  await expect.element(input).not.toBeInTheDocument()
  await expect.poll(() => editor.element().querySelector(".hina-comment")?.textContent).toBe("first.")
  await expect.element(page.getByRole("button", { name: "Comments 1" })).toBeInTheDocument()
  expect(saves).toEqual([])
})

test("keeps a comment on an edit until the edit is saved", async () => {
  await openDocument()
  nextSave = { type: "conflict", version: 2, revision: 2, markdown: "# Release plan\n\nThe agent's version.\n" }
  await typeAtEnd(" Mine.")
  await userEvent.keyboard("{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}")
  await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Comment" }).click()
  await userEvent.keyboard("Is this right?{Enter}")

  await expect.element(page.getByRole("alert").getByRole("button", { name: "Keep mine" })).toBeInTheDocument()
  await expect.element(page.getByRole("combobox", { name: "New comment" })).toBeInTheDocument()
  expect(commented).toEqual([])
})

test("highlights loaded comments without saving, and opens one from its highlight", async () => {
  feedback = {
    comments: [
      agentComment("c-editor", "editor", "Ship the ", "Which editor?"),
      agentComment("c-gone", "the toolbar", "", "Where did it go?"),
    ],
  }
  const editor = await openDocument()

  await expect.poll(() => editor.element().querySelector(".hina-comment")?.textContent).toBe("editor")
  expect(saves).toEqual([])
  expect(document.querySelector(".hina-document")?.innerHTML).not.toContain("Which editor?")

  await editor.getByText("editor", { exact: true }).click()
  const pane = page.getByRole("region", { name: "Comments" })
  const focused = pane.getByRole("article", { name: "Comment: Which editor?" })
  await expect.element(focused).toHaveAttribute("data-focused", "true")
  await expect.element(focused.getByText("Waiting on you")).toBeVisible()
  await expect
    .element(pane.getByRole("article", { name: "Comment: Where did it go?" }).getByText("The quoted text is gone"))
    .toBeVisible()
  expect(saves).toEqual([])
})

test("asks the agent to read the edited document from the thread's draft", async () => {
  await openDocument()
  await page.getByRole("button", { name: "Ask agent" }).click()

  expect(useDrafts.getState().byThreadId[thread.id]?.text).toContain(`"Release plan" (${documentId}, revision 1)`)
})

test("does not ask the agent to read a document whose edits did not save", async () => {
  useDrafts.getState().setText(thread.id, "")
  await openDocument()
  nextSave = { type: "conflict", version: 2, revision: 2, markdown: "# Release plan\n\nThe agent's version.\n" }
  await typeAtEnd(" Mine.")
  await page.getByRole("button", { name: "Ask agent" }).click()

  await expect.element(page.getByRole("button", { name: "Keep mine" })).toBeVisible()
  expect(saves).toHaveLength(1)
  expect(useDrafts.getState().byThreadId[thread.id]?.text ?? "").toBe("")
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

test("colors a callout's label and icon by its tone", async () => {
  const { editor } = await savedAfterEdit(CALLOUTS)

  const callouts = Array.from(editor.element().querySelectorAll("[data-callout]"))
  const inks = callouts.map((callout) => {
    const label = callout.querySelector("[data-callout-label]")!
    const icon = callout.querySelector("[data-callout-icon]")!
    expect(getComputedStyle(icon).color).toBe(getComputedStyle(label).color)
    return getComputedStyle(label).color
  })
  expect(new Set(inks).size).toBe(callouts.length)
  expect(inks).not.toContain(getComputedStyle(editor.element()).color)
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

  await expect
    .poll(() => editor.element().querySelector("[data-diagram-svg] > svg"), { timeout: 10_000 })
    .not.toBeNull()
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

const printed = async (html: string) => {
  const frame = document.createElement("iframe")
  frame.style.width = "800px"
  frame.srcdoc = documentPrintHtml("Release plan", html)
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }))
  document.body.append(frame)
  onTestFinished(() => frame.remove())
  await loaded
  return frame.contentDocument!
}

const shown = (element: Element | null | undefined) => element?.checkVisibility() ?? false

test("prints a callout's label and a diagram, without their controls or source", async () => {
  stored = { ...stored, markdown: `# Release plan\n\n> [!WARNING]\n> Saves race.\n\n${FLOWCHART}\n` }
  const editor = await openDocument()
  await expect
    .poll(() => editor.element().querySelector("[data-diagram-svg] > svg"), { timeout: 10_000 })
    .not.toBeNull()

  const print = await printed(await liveDocument(liveDocumentKey(undefined, documentId))!.html())
  const label = print.querySelector("[data-callout-label]")

  expect(shown(label)).toBe(true)
  expect(label?.textContent).toBe("Warning")
  expect(shown(label?.querySelector("[data-print-hidden]"))).toBe(false)
  expect(shown(print.querySelector("[data-callout] p"))).toBe(true)
  expect(shown(print.querySelector("[data-diagram-svg] > svg"))).toBe(true)
  expect(shown(print.querySelector("[data-diagram] pre"))).toBe(false)
  expect(shown(print.querySelector("[data-diagram] button"))).toBe(false)
})

const highlighted = (editor: Awaited<ReturnType<typeof openDocument>>) =>
  Array.from(editor.element().querySelectorAll(".hina-comment"), (mark) => mark.textContent)

const detachedNotice = (body: string) =>
  page
    .getByRole("region", { name: "Comments" })
    .getByRole("article", { name: `Comment: ${body}` })
    .getByText("The quoted text is gone")

test("keeps a highlight while the developer edits around its quote, drops it while the quote is edited, and restores it on undo", async () => {
  feedback = { comments: [agentComment("c-editor", "editor", "Ship the ", "Which editor?")] }
  const editor = await openDocument()
  await expect.poll(() => highlighted(editor)).toEqual(["editor"])

  await typeAtEnd(" Then the panel.")
  await expect.poll(() => highlighted(editor)).toEqual(["editor"])

  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard(`{Home}${"{ArrowRight}".repeat("Ship the e".length)}X`)
  await expect.poll(() => highlighted(editor)).toEqual([])

  await userEvent.keyboard(`{${mod}>}z{/${mod}}`)
  await expect.poll(() => highlighted(editor)).toEqual(["editor"])
  await page.getByRole("button", { name: "Comments 1" }).click()
  await expect
    .element(page.getByRole("region", { name: "Comments" }).getByRole("article", { name: "Comment: Which editor?" }))
    .toBeVisible()
  await expect.element(detachedNotice("Which editor?")).not.toBeInTheDocument()
})

test("detaches a comment when the developer deletes the line it quotes", async () => {
  feedback = { comments: [agentComment("c-editor", "editor", "Ship the ", "Which editor?")] }
  const editor = await openDocument()
  await expect.poll(() => highlighted(editor)).toEqual(["editor"])

  await page.getByText(/^Ship the/).click()
  await userEvent.keyboard("{End}{Shift>}{Home}{/Shift}{Backspace}")

  await expect.poll(() => highlighted(editor)).toEqual([])
  await expect.poll(() => saves.at(-1)?.markdown ?? "", { timeout: 3000 }).not.toContain("editor** first")
  await page.getByRole("button", { name: "Comments 1" }).click()
  await expect.element(detachedNotice("Which editor?")).toBeVisible()
})

test("follows a quote through the agent's republish, and detaches it when the agent drops the quote", async () => {
  feedback = { comments: [agentComment("c-editor", "editor", "Ship the ", "Which editor?")] }
  const editor = await openDocument()
  await expect.poll(() => highlighted(editor)).toEqual(["editor"])

  stored = { version: 2, revision: 2, markdown: "# Release plan\n\nA new intro.\n\nShip the editor first.\n" }
  push({ type: "artifact.updated", artifact: documentAt(2) })
  await expect.element(editor.getByText("A new intro.")).toBeInTheDocument()
  await expect.poll(() => highlighted(editor)).toEqual(["editor"])

  stored = { version: 3, revision: 3, markdown: "# Release plan\n\nShip the toolbar first.\n" }
  push({ type: "artifact.updated", artifact: documentAt(3) })
  await expect.element(editor.getByText("Ship the toolbar first.")).toBeInTheDocument()
  await expect.poll(() => highlighted(editor)).toEqual([])
  await page.getByRole("button", { name: "Comments 1" }).click()
  await expect.element(detachedNotice("Which editor?")).toBeVisible()
  expect(saves).toEqual([])
})

test("comments on text around emoji and right-to-left script and highlights the same text", async () => {
  stored = {
    ...stored,
    markdown: "# Release plan\n\n👩🏽‍💻 ships 🚀🚀 the editor.\n\nהעורך נשלח קודם. المحرر أولاً.\n",
  }
  const editor = await openDocument()
  await page.getByText(/ships/).click()
  await userEvent.keyboard(
    "{End}{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}",
  )
  await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Comment" }).click()
  await expect.element(page.getByRole("combobox", { name: "New comment" })).toHaveFocus()
  await userEvent.keyboard("Which one?{Enter}")

  await expect.poll(() => commented.length).toBe(1)
  expect(commented[0]).toMatchObject({ anchor: { quote: "editor." } })
  await expect.poll(() => highlighted(editor)).toEqual(["editor."])

  feedback = {
    comments: [
      ...feedback.comments,
      agentComment("c-rtl", "נשלח קודם", "העורך ", "Is this first?"),
      agentComment("c-emoji", "🚀🚀", "👩🏽‍💻 ships ", "Why twice?"),
    ],
  }
  push({ type: "artifact.feedback", id: documentId })
  await expect.poll(() => highlighted(editor).toSorted()).toEqual(["editor.", "נשלח קודם", "🚀🚀"].toSorted())
})

test("opens a long document and saves an edit at its end without losing a block", async () => {
  const sections = Array.from(
    { length: 400 },
    (_, index) => `## Step ${index + 1}\n\nThe agent writes paragraph ${index + 1} with **bold**, \`code\` and 🚀.\n`,
  )
  stored = { ...stored, markdown: `# Release plan\n\n${sections.join("\n")}` }
  const editor = await openDocument()
  await expect.element(editor.getByRole("heading", { name: "Step 400" })).toBeInTheDocument()

  await editor.getByText(/^The agent writes paragraph 400 with/).click()
  await userEvent.keyboard("{End} Done.")

  await expect.poll(() => saves.length, { timeout: 5000 }).toBe(1)
  const saved = saves[0]?.markdown ?? ""
  expect(saved.match(/^## Step \d+$/gm)).toHaveLength(400)
  expect(saved).toContain("The agent writes paragraph 400 with **bold**, `code` and 🚀. Done.")
})

const CHART = `\`\`\`chart
{
  "type": "bar",
  "title": "Saves peaked on Wednesday",
  "x": "day",
  "series": [{ "key": "saves", "label": "Saves" }],
  "rows": [
    { "day": "Mon", "saves": 3 },
    { "day": "Wed", "saves": 9 }
  ]
}
\`\`\``

test("draws a chart block, shows its rows, and saves its fence unchanged", async () => {
  const { editor, saved } = await savedAfterEdit(CHART)

  await expect
    .poll(() => editor.element().querySelector("[data-chart-title]")?.textContent)
    .toBe("Saves peaked on Wednesday")
  await expect.poll(() => editor.element().querySelector("[data-chart] svg"), { timeout: 10_000 }).not.toBeNull()
  await editor.getByRole("button", { name: "Data" }).click()
  await expect.element(editor.getByRole("cell", { name: "Wed" })).toBeVisible()
  expect(saved).toContain(CHART)
})

test("shows the error and the source of a chart that cannot be drawn", async () => {
  stored = { ...stored, markdown: '# Release plan\n\n```chart\n{ "type": "pie", "x": "day" }\n```\n' }
  const editor = await openDocument()

  await expect
    .poll(() => editor.element().querySelector("[data-chart] [role=alert]")?.textContent ?? "", { timeout: 10_000 })
    .not.toBe("")
  await expect.element(editor.getByRole("code")).toBeVisible()
  expect(saves).toEqual([])
})
test("lays out a right-to-left paragraph from the right", async () => {
  stored = { ...stored, markdown: "# Release plan\n\nהעורך נשלח קודם.\n\n- المحرر أولاً.\n\nShip the editor first.\n" }
  const editor = await openDocument()
  const direction = (text: RegExp) => getComputedStyle(editor.getByText(text).element()).direction

  expect(direction(/^העורך/)).toBe("rtl")
  expect(direction(/^المحرر/)).toBe("rtl")
  expect(direction(/^Ship the/)).toBe("ltr")
})
test("highlights an agent's quote copied from the Markdown, with its formatting syntax", async () => {
  feedback = { comments: [agentComment("c-ship", "Ship the **editor** first.", "", "Ship the panel first?")] }
  const editor = await openDocument()

  await expect
    .poll(() => Array.from(editor.element().querySelectorAll(".hina-comment"), (mark) => mark.textContent).join(""))
    .toBe("Ship the editor first.")
  await page.getByRole("button", { name: "Comments 1" }).click()
  const comment = page
    .getByRole("region", { name: "Comments" })
    .getByRole("article", { name: "Comment: Ship the panel first?" })
  await expect.element(comment).toBeVisible()
  await expect.element(comment.getByText("The quoted text is gone")).not.toBeInTheDocument()
})
