import { expect, test } from "vitest"
import { largeDocument } from "./fixtures/index.ts"
import {
  chunkNodes,
  documentChunks,
  documentMarkdownManager,
  parseDocument,
  type PreviousChunks,
  serializeDocument,
} from "./parse.ts"

const FRAGMENTS = [
  "# ",
  "## ",
  "- ",
  "  - ",
  "1. ",
  "3) ",
  "- [ ] ",
  "- [x] ",
  "> ",
  "> [!NOTE]",
  "> [!WARNING]\n> ",
  "```",
  "```ts\n",
  '```chart\n{"type":"bar"',
  "~~~",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "|",
  "---",
  "***",
  "**",
  "*",
  "_",
  "~~",
  "`",
  "[",
  "](",
  "https://example.com",
  "![alt](images/x.png)",
  "<em>",
  "</em>",
  "<br>",
  "<!-- ",
  " -->",
  "<details>",
  "\\",
  "  \n",
  "\n",
  "\n\n",
  "\n\n\n",
  "\t",
  "    ",
  "text",
  "日本語",
  "مرحبا",
  "👩🏽‍💻",
  "\u0000",
  "\ud83d",
  "[ref]: https://example.com",
]

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const document = (next: () => number, pieces: number) =>
  Array.from({ length: pieces }, () => {
    const roll = next()
    if (roll < 0.1) return String.fromCharCode(Math.floor(next() * 0xffff))
    return FRAGMENTS[Math.floor(roll * FRAGMENTS.length)]!
  }).join("")

const INLINE = FRAGMENTS.filter((fragment) => !/[\n`|]|^\[ref\]|^[#>\-*~0-9 ]/.test(fragment))

const BLOCKS: ReadonlyArray<(inline: string) => string> = [
  (inline) => `Paragraph ${inline} end.`,
  (inline) => `## Heading ${inline}`,
  (inline) => `- one ${inline}\n- two\n  - nested ${inline}`,
  (inline) => `1. first ${inline}\n2. second`,
  (inline) => `- [ ] task ${inline}\n- [x] done`,
  (inline) => `> quote ${inline}`,
  (inline) => `> [!TIP]\n> tip ${inline}\n>\n> - point`,
  (inline) => `\`\`\`ts\nconst x = "${inline}"\n\`\`\``,
  (inline) => `| a | b |\n| --- | --- |\n| ${inline} | 2 |`,
  () => "---",
  (inline) => `Line ${inline}\\\nnext line`,
  (inline) => `<em>${inline}</em> html`,
]

const blocks = (next: () => number, count: number) =>
  Array.from({ length: count }, () => {
    const inline = Array.from({ length: 3 }, () => INLINE[Math.floor(next() * INLINE.length)]!).join("")
    return BLOCKS[Math.floor(next() * BLOCKS.length)]!(inline)
  }).join(next() < 0.2 ? "\n\n\n" : "\n\n")

const wholeParse = (markdown: string) => {
  const { schema, markdown: manager } = documentMarkdownManager()
  const content = manager.parse(markdown).content ?? []
  return content.length === 0 ? schema.topNodeType.createAndFill()! : schema.nodeFromJSON({ type: "doc", content })
}

test("any text parses into a document, saves, and parses again without throwing", () => {
  const next = random(7)
  for (let round = 0; round < 400; round++) {
    const markdown = document(next, 1 + Math.floor(next() * 80))
    const { doc } = parseDocument(markdown)
    expect(doc.type.name).toBe("doc")
    expect(() => parseDocument(serializeDocument(doc))).not.toThrow()
  }
})

test("a document longer than one chunk parses as it would whole", () => {
  const next = random(11)
  for (let round = 0; round < 12; round++) {
    const markdown = Array.from({ length: 300 }, () => blocks(next, 3)).join("\n\n")
    expect([...documentChunks(documentMarkdownManager(), markdown)].length).toBeGreaterThan(1)
    const chunked = parseDocument(markdown)
    expect(chunked.lossy).toBe(false)
    expect(chunked.doc.toJSON()).toEqual(wholeParse(markdown).toJSON())
  }
})

const chunkedParse = (markdown: string, previous?: PreviousChunks) => {
  const manager = documentMarkdownManager()
  const steps = [...documentChunks(manager, markdown, previous)]
  let at = 0
  for (const { chunk } of steps) {
    expect(chunk.start).toBe(at)
    at = chunk.next
  }
  expect(at).toBe(markdown.length)
  const nodes = steps.flatMap(({ chunk }) => chunkNodes(manager, chunk).nodes)
  const { topNodeType } = manager.schema
  const doc = nodes.length === 0 ? topNodeType.createAndFill()! : topNodeType.create(null, nodes)
  return { doc, steps, previous: { source: markdown, chunks: steps.map(({ chunk }) => chunk) } }
}

const EDITS = ["x", "```", "\n", "\n\n", "- ", "> ", "| a |\n| --- |\n", "# ", "**", "\n\n- item\n", "~~~\n", ""]

test("re-chunking after an edit, reusing unchanged chunks, parses as the edited document would whole", () => {
  const next = random(23)
  let reused = 0
  for (let round = 0; round < 40; round++) {
    const before = Array.from({ length: 120 }, () => blocks(next, 3)).join("\n\n")
    const { previous } = chunkedParse(before)
    const from = Math.floor(next() * before.length)
    const to = Math.min(before.length, from + Math.floor(next() * 40))
    const after = before.slice(0, from) + EDITS[Math.floor(next() * EDITS.length)]! + before.slice(to)
    const edited = chunkedParse(after, previous)
    reused += edited.steps.filter((step) => step.previous !== null).length
    expect(edited.doc.toJSON()).toEqual(wholeParse(after).toJSON())
  }
  expect(reused).toBeGreaterThanOrEqual(40)
})

test("changing one paragraph of a large document lexes only the chunk around it", () => {
  const before = largeDocument()
  const { previous } = chunkedParse(before)
  const after = before.replace("Paragraph 40 explains", "Paragraph 40 now explains")
  const { steps } = chunkedParse(after, previous)
  expect(steps.filter((step) => step.previous === null).length).toBeLessThanOrEqual(2)
  expect(steps.length).toBeGreaterThan(20)
})

const longFiller = Array.from({ length: 400 }, (_, index) => `Filler paragraph ${index} with enough words.`).join(
  "\n\n",
)

test("a reference definition inside a quote or a list resolves across chunks", () => {
  for (const definition of ["> [guide]: https://example.com", "- [guide]: https://example.com"]) {
    const markdown = `See [docs][guide].\n\n${longFiller}\n\n${definition}`
    expect(parseDocument(markdown).doc.toJSON()).toEqual(wholeParse(markdown).toJSON())
  }
})

test("a CRLF document is cut into the same chunks as its LF copy", () => {
  const lf = `${longFiller}\n\n${longFiller}`
  const crlf = lf.replace(/\n/g, "\r\n")
  const manager = documentMarkdownManager()
  expect([...documentChunks(manager, crlf)].length).toBe([...documentChunks(manager, lf)].length)
  expect(parseDocument(crlf).doc.toJSON()).toEqual(wholeParse(lf).toJSON())
})
