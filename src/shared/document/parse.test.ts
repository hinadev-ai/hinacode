import { expect, test } from "vitest"
import { documentChunks, documentMarkdownManager, parseDocument, serializeDocument } from "./parse.ts"

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
