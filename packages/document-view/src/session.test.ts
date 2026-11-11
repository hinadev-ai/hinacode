import { expect, test } from "vitest"
import { largeDocument } from "../../../src/shared/document/fixtures/index.ts"
import { Transform } from "@tiptap/pm/transform"
import { parseDocument } from "../../../src/shared/document/parse.ts"
import type { BlockPatch, RenderBlock } from "./blocks.ts"
import { applyPatch } from "./patch.ts"
import { renderBlocks } from "./renderBlocks.ts"
import { drawDiagram } from "./diagram.ts"
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

const open = (markdown: string, options: Pick<Parameters<typeof createDocumentSession>[0], "highlight"> = {}) => {
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
    ...options,
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
    series: [{ label: "A", values: [3, 0] }],
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

test("a mermaid block is drawn after load, and only that block is patched", async () => {
  const clock = manualClock()
  const patches: BlockPatch[] = []
  const drawn = Promise.withResolvers<void>()
  const session = createDocumentSession({
    send: (patch) => {
      patches.push(patch)
      if (patch.insert.some((block) => block.kind === "diagram" && block.drawing !== undefined)) drawn.resolve()
    },
    schedule: clock.schedule,
    now: clock.now,
    drawDiagram,
  })
  session.load("Before.\n\n```mermaid\ngraph TD\n  A[Plan] --> B[Ship]\n```\n\nAfter.")
  clock.drain()
  expect(session.blocks.map((block) => block.kind)).toEqual(["paragraph", "diagram", "paragraph"])
  patches.length = 0
  await drawn.promise
  expect(patches).toHaveLength(1)
  expect(patches[0]).toMatchObject({ start: 1, deleteCount: 1 })
  const [diagram] = patches[0]!.insert
  expect(diagram).toMatchObject({ kind: "diagram", source: "graph TD\n  A[Plan] --> B[Ship]" })
  expect(
    diagram?.kind === "diagram" &&
      diagram.drawing?.shapes.some((shape) => shape.kind === "text" && shape.text === "Plan"),
  ).toBe(true)
})

test("code blocks carry the highlighter's color ranges", () => {
  const { clock, shown } = open("```ts\nconst x = 1\n```", { highlight: (text) => [[0, text.indexOf(" "), "#ff0000"]] })
  clock.drain()
  expect(shown()).toMatchObject([{ kind: "code", language: "ts", tokens: [[0, 5, "#ff0000"]] }])
})

const editable = (markdown: string) => {
  const opened = open(markdown)
  opened.clock.drain()
  opened.patches.length = 0
  const indexOf = (text: string) =>
    opened.shown().findIndex((block) => "runs" in block && block.runs.some((run) => run.text.includes(text)))
  return { ...opened, indexOf }
}

test("typing in the middle of a large document patches only that block and echoes the event count", () => {
  const { session, patches, shown, indexOf } = editable(largeDocument())
  const count = shown().length
  const block = indexOf("Paragraph 40 explains")
  session.edit({ eventCount: 7, block, cell: null, from: "Paragraph 40".length, to: "Paragraph 40".length, text: "0" })
  session.edit({ eventCount: 8, block, cell: null, from: 0, to: "Paragraph".length, text: "段落" })
  const edits = patches.filter((patch) => patch.start === block)
  expect(edits.map(({ deleteCount, insert, eventCount }) => [deleteCount, insert.length, eventCount])).toEqual([
    [1, 1, 7],
    [1, 1, 8],
  ])
  expect(patches.every((patch) => patch.deleteCount <= 1 && patch.insert.length <= 1)).toBe(true)
  expect(shown().length - count).toBeLessThanOrEqual(1)
  const edited = shown()[block]
  expect(edited?.kind === "paragraph" && edited.runs[0]?.text).toMatch(/^段落 400 explains/)
  expect(session.markdown()).toContain("段落 400 explains the **plan**")
})

test("Enter in a list item makes a new item and places the caret in it", () => {
  const { session, patches, shown, indexOf } = editable("- one two\n- three")
  const block = indexOf("one two")
  session.select({ anchor: { block, cell: null, offset: 3 }, head: { block, cell: null, offset: 3 } })
  session.press("Enter", false, 1)
  expect(
    shown()
      .map((b) => ("runs" in b ? b.runs.map((run) => run.text).join("") : b.kind))
      .slice(0, 3),
  ).toEqual(["one", " two", "three"])
  const selection = patches.at(-1)?.selection
  expect(selection).toEqual({ anchor: { block: 1, cell: null, offset: 0 }, head: { block: 1, cell: null, offset: 0 } })
  expect(session.markdown().trimEnd()).toBe("- one\n-  two\n- three")
})

test("tapping a task checks only that task", () => {
  const { session, patches, shown, indexOf } = editable("- [ ] one\n- [ ] two")
  session.toggleTask(indexOf("two"))
  expect(patches[0]).toMatchObject({ start: 1, deleteCount: 1 })
  expect(
    shown()
      .map((block) => block.containers)
      .slice(0, 2),
  ).toEqual([[{ kind: "task", checked: false, first: true }], [{ kind: "task", checked: true, first: true }]])
  expect(session.markdown().trimEnd()).toBe("- [ ] one\n- [x] two")
})

test("a selection across blocks maps to the document and back", () => {
  const { session, indexOf } = editable("First paragraph.\n\n## Heading\n\nLast one.")
  const anchor = { block: indexOf("First"), cell: null, offset: 6 }
  const head = { block: indexOf("Last"), cell: null, offset: 4 }
  session.select({ anchor, head })
  const { from, to } = session.editor.state.selection
  expect(session.editor.state.doc.textBetween(from, to, "|")).toBe("paragraph.|Heading|Last")
  session.run(() => session.editor.commands.toggleBold())
  expect(session.markdown().trimEnd()).toBe("First **paragraph.**\n\n## **Heading**\n\n**Last** one.")
})

test("typing inside a table cell edits that cell", () => {
  const { session, indexOf, shown } = editable("Intro\n\n| a | b |\n| --- | --- |\n| one | two |")
  const table = shown().findIndex((block) => block.kind === "table")
  expect(indexOf("Intro")).toBe(0)
  session.edit({ eventCount: 1, block: table, cell: [1, 1], from: 3, to: 3, text: "!" })
  expect(session.markdown()).toContain("| one | two! |")
})

test("two quotes in a row stay two quotes", () => {
  const { blocks } = renderBlocks(parseDocument("> one\n>\n> two\n\n> three").doc)
  expect(blocks.map((block) => block.containers)).toEqual([
    [{ kind: "quote", first: true, last: false }],
    [{ kind: "quote", first: false, last: true }],
    [{ kind: "quote", first: true, last: true }],
  ])
})

test("text typed after toggling a mark at the caret carries that mark", () => {
  const { session, indexOf } = editable("Plain text")
  const block = indexOf("Plain")
  const caret = { block, cell: null, offset: 5 }
  session.select({ anchor: caret, head: caret })
  session.run(() => session.editor.commands.toggleBold())
  session.edit({ eventCount: 1, block, cell: null, from: 5, to: 5, text: "BOLD" })
  expect(session.markdown().trimEnd()).toBe("Plain**BOLD** text")
})

test("a chart's missing and null values draw as zero, as on the desktop", () => {
  const chart =
    '```chart\n{"type":"line","x":"d","series":[{"key":"a"}],"rows":[{"d":"1","a":5},{"d":"2","a":null},{"d":"3"},{"d":"4","a":7}]}\n```'
  const { blocks } = renderBlocks(parseDocument(chart).doc)
  expect(blocks[0]).toMatchObject({ kind: "chart", series: [{ values: [5, 0, 0, 7] }] })
})

test("an edit the model rejects is dropped and its block is sent again instead of throwing", () => {
  const { session, patches, shown } = editable("Inline ![dot](images/a.png) image.\n\nNext.")
  const before = session.markdown()
  expect(session.edit({ eventCount: 3, block: 0, cell: null, from: 2, to: 2, text: "X" })).toBe(false)
  expect(session.markdown()).toBe(before)
  expect(patches.at(-1)).toMatchObject({ start: 0, deleteCount: 1, eventCount: 3 })
  expect(shown()[0]).toEqual(session.blocks[0])
})

test("reloading a loaded document finishes at once, so no edit can land between its slices", () => {
  const { session, clock } = open(largeDocument())
  clock.drain()
  session.load(largeDocument().replace("Paragraph 40 explains", "Paragraph 40 now explains"))
  expect(session.markdown()).toContain("Paragraph 40 now explains")
})

test("a selection carries the view's event count, so later patches are not mistaken for stale ones", () => {
  const { session, patches, indexOf } = editable("First.\n\nSecond.")
  const caret = { block: indexOf("Second"), cell: null, offset: 0 }
  session.select({ anchor: caret, head: caret, eventCount: 5 })
  session.run(() => session.editor.commands.toggleHeading({ level: 2 }))
  expect(patches.length).toBeGreaterThan(0)
  expect(patches.every((patch) => patch.eventCount === 5)).toBe(true)
})
