import { Editor } from "@tiptap/core"
import { expect, onTestFinished, test } from "vitest"
import { documentExtensions, documentMarkdown } from "../../../shared/document/schema.ts"
import "../../index.css"
import { CodeHighlight } from "./codeHighlight.ts"

const openEditor = (markdown: string) => {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [...documentExtensions(), documentMarkdown(), CodeHighlight],
    content: markdown,
    contentType: "markdown",
  })
  onTestFinished(() => {
    editor.destroy()
    element.remove()
  })
  return element
}

const coloredRuns = (element: HTMLElement) => element.querySelectorAll("pre span[style*='color']").length

test("colors code in every editor that opens while the language's highlighter loads", async () => {
  const first = openEditor("```python\nprint('first')\n```\n")
  const second = openEditor("```python\nprint('second')\n```\n")

  await expect.poll(() => coloredRuns(first), { timeout: 10_000 }).toBeGreaterThan(1)
  await expect.poll(() => coloredRuns(second), { timeout: 3000 }).toBeGreaterThan(1)
})
