import { describe, expect, test } from "vitest"
import { documentOutline, OUTLINE_MAX_BLOCKS } from "./documentOutline.ts"

const designDoc = `# Artifact skills

> [!NOTE]
> Agents learn **two genres** from [templates](https://example.com) and \`auto_open\` shows the result.

## Problem

Agents rediscover the shape of a good document every time.
They also write it differently each time.

## Steps

- [x] Define the data shape
- [ ] Build the editor
- [X] Verify in the real app

| Part | Owner | State |
| --- | --- | --- |
| Store | Agent | Done |
| Editor | Developer | Open |

\`\`\`mermaid
graph LR
  A --> B
\`\`\`

\`\`\`chart
{ "type": "bar" }
\`\`\`

\`\`\`ts
type ArtifactKind = "page" | "document"
\`\`\`

1. First
2. Second
   continued
3. Third

> A plain quote.
`

describe("documentOutline", () => {
  test("reads a design document block by block", () => {
    expect(documentOutline(designDoc)).toEqual({
      title: "Artifact skills",
      lede: "Agents learn two genres from templates and auto_open shows the result.",
      blocks: [
        { kind: "heading", level: 1, text: "Artifact skills" },
        { kind: "callout", tone: "note" },
        { kind: "heading", level: 2, text: "Problem" },
        { kind: "text", length: 100 },
        { kind: "heading", level: 2, text: "Steps" },
        { kind: "tasks", done: 2, total: 3 },
        { kind: "table", rows: 2, columns: 3 },
        { kind: "diagram" },
        { kind: "chart" },
        { kind: "code" },
        { kind: "list", items: 3 },
        { kind: "text", length: 14 },
      ],
    })
  })

  test("returns nothing for an empty document", () => {
    expect(documentOutline("")).toEqual({ title: null, lede: null, blocks: [] })
    expect(documentOutline("\n\n  \n")).toEqual({ title: null, lede: null, blocks: [] })
  })

  test("takes the lede from the first paragraph when there are no headings", () => {
    const outline = documentOutline("Just one line.\n\nAnd another *one*.")
    expect(outline.title).toBe(null)
    expect(outline.lede).toBe("Just one line.")
    expect(outline.blocks).toEqual([
      { kind: "text", length: 14 },
      { kind: "text", length: 16 },
    ])
  })

  test("reads a document that is only a code fence, closed or not", () => {
    expect(documentOutline("```sh\npnpm test\n```")).toEqual({ title: null, lede: null, blocks: [{ kind: "code" }] })
    expect(documentOutline("# Notes\n\n```mermaid\ngraph TD\n# not a heading\n\nmore")).toEqual({
      title: "Notes",
      lede: null,
      blocks: [{ kind: "heading", level: 1, text: "Notes" }, { kind: "diagram" }],
    })
  })

  test("reads a callout of any tone and case as the first block", () => {
    const outline = documentOutline("> [!warning]\n> The migration drops a column.\n\nThen a paragraph.")
    expect(outline.blocks[0]).toEqual({ kind: "callout", tone: "warning" })
    expect(outline.lede).toBe("The migration drops a column.")
  })

  test("skips an empty callout when it looks for the lede", () => {
    expect(documentOutline("> [!TIP]\n\nThe real opening.").lede).toBe("The real opening.")
  })

  test("keeps CJK text whole and cuts a long one at the limit", () => {
    const outline = documentOutline(`# 設計ドキュメント\n\n${"成果物を共有する。".repeat(40)}`)
    expect(outline.title).toBe("設計ドキュメント")
    expect(outline.lede?.endsWith("…")).toBe(true)
    expect([...(outline.lede ?? "")].length).toBeLessThanOrEqual(241)
    expect(outline.lede?.startsWith("成果物を共有する。成果物")).toBe(true)
  })

  test("cuts a long lede on a word boundary", () => {
    const lede = documentOutline("word ".repeat(100)).lede ?? ""
    expect(lede.endsWith("word…")).toBe(true)
    expect(lede.length).toBeLessThanOrEqual(241)
  })

  test("reads setext headings and ignores thematic breaks", () => {
    expect(documentOutline("Title\n=====\n\nSection\n---\n\n***\n").blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "heading", level: 2, text: "Section" },
    ])
  })

  test("counts deeper headings as text", () => {
    expect(documentOutline("#### Detail").blocks).toEqual([{ kind: "text", length: 6 }])
  })

  test("stops after the block limit in a huge document", () => {
    const outline = documentOutline("## Part\n\nBody.\n\n".repeat(10_000))
    expect(outline.blocks.length).toBe(OUTLINE_MAX_BLOCKS)
  })
})
