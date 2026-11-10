import { expect, test } from "vitest"
import { largeDocument } from "../../../src/shared/document/fixtures/index.ts"
import { Transform } from "@tiptap/pm/transform"
import { parseDocument } from "../../../src/shared/document/parse.ts"
import type { BlockPatch, RenderBlock } from "./blocks.ts"
import { applyPatch } from "./patch.ts"
import { renderBlocks } from "./renderBlocks.ts"
import { createDocumentSession } from "./session.ts"

const manualClock = () => {
  let time = 0
  const queue: (() => void)[] = []
  return {
    now: () => (time += 1),
    schedule: (run: () => void) => void queue.push(run),
    drain: () => {
      while (queue.length > 0) queue.shift()!()
    },
  }
}

const open = (markdown: string) => {
  const clock = manualClock()
  const patches: BlockPatch[] = []
  let shown: RenderBlock[] = []
  const session = createDocumentSession({
    send: (patch) => {
      patches.push(patch)
      shown = applyPatch(shown, patch)
    },
    schedule: clock.schedule,
    now: clock.now,
    sliceMs: 3,
  })
  session.load(markdown)
  return { session, clock, patches, shown: () => shown }
}

test("a large document shows its first blocks before the rest is parsed, and ends as a one-shot render", () => {
  const markdown = largeDocument()
  const { clock, patches, shown } = open(markdown)
  expect(patches.length).toBeGreaterThan(0)
  const firstScreen = shown().length
  clock.drain()
  expect(firstScreen).toBeLessThan(shown().length)
  expect(shown().map(({ id: _id, containers, ...body }) => [body, containers])).toEqual(
    renderBlocks(parseDocument(markdown).doc).blocks.map(({ id: _id, containers, ...body }) => [body, containers]),
  )
})

test("changing one paragraph of a large document patches only that block", () => {
  const markdown = largeDocument()
  const { session, clock, patches, shown } = open(markdown)
  clock.drain()
  const before = shown()
  patches.length = 0
  const target = "Paragraph 40 explains"
  expect(markdown.split(target).length).toBe(2)
  session.load(markdown.replace(target, "Paragraph 40 now explains"))
  clock.drain()
  expect(patches).toHaveLength(1)
  expect(patches[0]!.deleteCount).toBe(1)
  expect(patches[0]!.insert).toHaveLength(1)
  expect(shown()).toHaveLength(before.length)
})

test("a newer load replaces one still in progress", () => {
  const { session, clock, shown } = open(largeDocument())
  session.load("# Replaced\n\nOnly this.")
  clock.drain()
  expect(shown().map((block) => block.kind)).toEqual(["heading", "paragraph"])
})

test("an empty document shows one empty paragraph, as the desktop does", () => {
  const { clock, shown } = open("")
  clock.drain()
  expect(shown()).toMatchObject([{ kind: "paragraph", runs: [] }])
})

test("blocks inside lists, quotes and callouts carry their containers, outermost first", () => {
  const { blocks } = renderBlocks(
    parseDocument("> [!TIP]\n> First.\n>\n> - one\n>   - nested\n> - two\n\n3. three\n4. four").doc,
  )
  expect(blocks.map((block) => block.containers)).toEqual([
    [{ kind: "callout", tone: "tip", first: true, last: false }],
    [
      { kind: "callout", tone: "tip", first: false, last: false },
      { kind: "bullet", first: true },
    ],
    [
      { kind: "callout", tone: "tip", first: false, last: false },
      { kind: "bullet", first: false },
      { kind: "bullet", first: true },
    ],
    [
      { kind: "callout", tone: "tip", first: false, last: true },
      { kind: "bullet", first: true },
    ],
    [{ kind: "ordered", number: 3, first: true }],
    [{ kind: "ordered", number: 4, first: true }],
  ])
})

test("toggling a task changes that block's id and keeps the others", () => {
  const { doc } = parseDocument("- [ ] one\n- [ ] two")
  const toggled = renderBlocks(doc)
  const taskItem = toggled.sources[1]!.owners[0]!
  const after = renderBlocks(new Transform(doc).setNodeMarkup(taskItem, undefined, { checked: true }).doc)
  expect(after.blocks[0]!.id).toBe(toggled.blocks[0]!.id)
  expect(after.blocks[1]!.id).not.toBe(toggled.blocks[1]!.id)
  expect(after.blocks[1]!.containers).toEqual([{ kind: "task", checked: true, first: true }])
})

test("charts, diagrams, invalid charts and tables become their own blocks", () => {
  const chart =
    '```chart\n{"type":"bar","x":"d","series":[{"key":"a","label":"A"}],"rows":[{"d":"mon","a":3},{"d":"tue"}]}\n```'
  const { blocks } = renderBlocks(
    parseDocument(
      `${chart}\n\n\`\`\`chart\nnot json\n\`\`\`\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n\n| a | b |\n| :-- | --: |\n| **x** | y |`,
    ).doc,
  )
  expect(blocks[0]).toMatchObject({
    kind: "chart",
    type: "bar",
    x: ["mon", "tue"],
    series: [{ label: "A", values: [3, null] }],
  })
  expect(blocks[1]).toMatchObject({ kind: "code", language: "chart" })
  expect(blocks[1]).toHaveProperty("error")
  expect(blocks[2]).toMatchObject({ kind: "diagram", source: "graph TD" })
  expect(blocks[3]).toMatchObject({ kind: "table", header: true, align: ["left", "right"] })
  expect(blocks[3]).toMatchObject({
    rows: [
      [[{ text: "a" }], [{ text: "b" }]],
      [[{ text: "x", marks: 1 }], [{ text: "y" }]],
    ],
  })
})
