import { Editor } from "@tiptap/core"
import { expect, test } from "vitest"
import { fixtures, largeDocument } from "../../../shared/document/fixtures/index.ts"
import { DocumentHtmlParser } from "../../../shared/document/htmlParser.ts"
import { parseDocument, serializeDocument } from "../../../shared/document/parse.ts"
import { documentExtensions, documentMarkdown } from "../../../shared/document/schema.ts"

const desktop = (markdown: string) => {
  const editor = new Editor({
    extensions: [...documentExtensions(), documentMarkdown()],
    content: markdown,
    contentType: "markdown",
  })
  const result = { json: editor.getJSON(), markdown: editor.getMarkdown() }
  editor.destroy()
  return result
}

const onPhone = <T,>(run: () => T): T => {
  const browserParser = window.DOMParser
  Object.defineProperty(window, "DOMParser", { value: DocumentHtmlParser, configurable: true })
  try {
    return run()
  } finally {
    Object.defineProperty(window, "DOMParser", { value: browserParser, configurable: true })
  }
}

const phone = (markdown: string) =>
  onPhone(() => {
    const { doc, lossy } = parseDocument(markdown)
    return { json: doc.toJSON(), markdown: serializeDocument(doc), lossy }
  })

test.each(fixtures)("$name parses and saves as the desktop editor does", ({ markdown }) => {
  const expected = desktop(markdown)
  const actual = phone(markdown)
  expect(actual.lossy).toBe(false)
  expect(actual.json).toEqual(expected.json)
  expect(actual.markdown).toBe(expected.markdown)
})

test("a large document parsed in chunks equals the desktop's whole parse", () => {
  const markdown = largeDocument()
  expect(phone(markdown).json).toEqual(desktop(markdown).json)
})

test("every fixture in one document, cut at many boundaries, equals the desktop's parse", () => {
  const markdown = fixtures.map((fixture) => fixture.markdown.trim()).join("\n\n")
  expect(phone(markdown).json).toEqual(desktop(markdown).json)
})
