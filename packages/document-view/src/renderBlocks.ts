import type { Mark, Node } from "@tiptap/pm/model"
import { calloutTone } from "../../../src/shared/documentCallout.ts"
import { parseChart } from "../../../src/shared/documentChart.ts"
import type { BlockBody, CodeToken, Container, DiagramDrawing, RenderBlock, Run, TableAlign } from "./blocks.ts"
import { MARKS } from "./protocol.ts"

type Body = BlockBody

export type Decorate = {
  readonly code?: (text: string, language: string) => ReadonlyArray<CodeToken> | undefined
  readonly drawing?: (source: string) => DiagramDrawing | undefined
}

const PLAIN: Decorate = {}

type Frame = { readonly container: Container; readonly owner: number; emitted: number; lastIndex: number }

const markBits = (marks: ReadonlyArray<Mark>) =>
  marks.reduce((bits, mark) => bits | (MARKS[mark.type.name as keyof typeof MARKS] ?? 0), 0)

const hrefOf = (marks: ReadonlyArray<Mark>) => {
  const link = marks.find((mark) => mark.type.name === "link")
  return typeof link?.attrs["href"] === "string" ? link.attrs["href"] : undefined
}

const runOf = (text: string, marks: ReadonlyArray<Mark>, image?: string): Run => {
  const href = hrefOf(marks)
  return {
    text,
    marks: markBits(marks),
    ...(href === undefined ? {} : { href }),
    ...(image === undefined ? {} : { image }),
  }
}

export const inlineRuns = (textblock: Node): Run[] => {
  const runs: Run[] = []
  textblock.forEach((child) => {
    if (child.isText) runs.push(runOf(child.text ?? "", child.marks))
    else if (child.type.name === "hardBreak") runs.push({ text: "\n", marks: 0 })
    else if (child.type.name === "image") runs.push(runOf("￼", child.marks, String(child.attrs["src"] ?? "")))
    else runs.push(runOf(child.textContent || "￼", child.marks))
  })
  return runs
}

const cellRuns = (cell: Node): Run[] => {
  const runs: Run[] = []
  cell.forEach((child, _, index) => {
    if (index > 0) runs.push({ text: "\n", marks: 0 })
    runs.push(...(child.isTextblock ? inlineRuns(child) : [{ text: child.textContent, marks: 0 }]))
  })
  return runs
}

const alignOf = (cell: Node): TableAlign => {
  const align = cell.attrs["align"]
  return align === "left" || align === "center" || align === "right" ? align : null
}

const codeBody = (node: Node, decorate: Decorate): Body => {
  const language = typeof node.attrs["language"] === "string" ? node.attrs["language"] : ""
  const text = node.textContent
  if (language === "mermaid") {
    const drawing = decorate.drawing?.(text)
    return drawing === undefined ? { kind: "diagram", source: text } : { kind: "diagram", source: text, drawing }
  }
  if (language !== "chart") {
    const tokens = decorate.code?.(text, language)
    return tokens === undefined || tokens.length === 0
      ? { kind: "code", language, text }
      : { kind: "code", language, text, tokens }
  }
  const parsed = parseChart(text)
  if (!parsed.ok) return { kind: "code", language, text, error: parsed.message }
  const { spec, labels } = parsed.chart
  return {
    kind: "chart",
    type: spec.type,
    title: spec.title ?? "",
    notes: spec.notes ?? "",
    x: spec.rows.map((row) => String(row[spec.x] ?? "")),
    series: spec.series.map(({ key }, index) => ({
      label: labels[index] ?? key,
      values: spec.rows.map((row) => {
        const value = row[key]
        return typeof value === "number" ? value : null
      }),
    })),
    prefix: spec.unit?.prefix ?? "",
    suffix: spec.unit?.suffix ?? "",
  }
}

const tableBody = (table: Node): Body => {
  const rows: Run[][][] = []
  let align: TableAlign[] = []
  let header = false
  table.forEach((row, _, rowIndex) => {
    const cells: Run[][] = []
    row.forEach((cell) => cells.push(cellRuns(cell)))
    if (rowIndex === 0) {
      header = row.firstChild?.type.name === "tableHeader"
      align = []
      row.forEach((cell) => align.push(alignOf(cell)))
    }
    rows.push(cells)
  })
  return { kind: "table", align, header, rows }
}

const leafBody = (node: Node, decorate: Decorate): Body | null => {
  switch (node.type.name) {
    case "paragraph":
      return { kind: "paragraph", runs: inlineRuns(node) }
    case "heading":
      return { kind: "heading", level: Number(node.attrs["level"] ?? 1), runs: inlineRuns(node) }
    case "codeBlock":
      return codeBody(node, decorate)
    case "table":
      return tableBody(node)
    case "image":
      return { kind: "image", src: String(node.attrs["src"] ?? ""), alt: String(node.attrs["alt"] ?? "") }
    case "horizontalRule":
      return { kind: "rule" }
    default:
      return node.isTextblock ? { kind: "paragraph", runs: inlineRuns(node) } : null
  }
}

const bodies = new WeakMap<Decorate, WeakMap<Node, Body>>()
const nodeIds = new WeakMap<Node, number>()
let nextNodeId = 1

const isDiagram = (node: Node) => node.type.name === "codeBlock" && node.attrs["language"] === "mermaid"

const bodyOf = (node: Node, decorate: Decorate): Body => {
  let cache = bodies.get(decorate)
  if (cache === undefined) bodies.set(decorate, (cache = new WeakMap()))
  const cached = cache.get(node)
  if (cached !== undefined) return cached
  const body = leafBody(node, decorate) ?? { kind: "unsupported", source: node.textContent }
  if (!isDiagram(node)) cache.set(node, body)
  return body
}

const nodeId = (node: Node) => {
  let id = nodeIds.get(node)
  if (id === undefined) {
    id = nextNodeId++
    nodeIds.set(node, id)
  }
  return id
}

const signature = (container: Container) => {
  switch (container.kind) {
    case "bullet":
      return container.first ? "b" : "B"
    case "ordered":
      return `${container.first ? "o" : "O"}${container.number}`
    case "task":
      return `${container.first ? "t" : "T"}${container.checked ? 1 : 0}`
    case "quote":
      return "q"
    case "callout":
      return `c${container.tone}${container.first ? 1 : 0}${container.last ? 1 : 0}`
  }
}

const blockId = (node: Node, body: Body, containers: ReadonlyArray<Container>) => {
  const own = body.kind === "diagram" && body.drawing !== undefined ? `${nodeId(node)}d` : String(nodeId(node))
  return containers.length === 0 ? own : `${own}:${containers.map(signature).join(".")}`
}

export type BlockSource = {
  readonly node: Node
  pos: number
  top: number
  readonly owners: number[]
}

export type RenderOptions = {
  readonly start?: number
  readonly top?: number
  readonly decorate?: Decorate
  readonly taken?: ReadonlySet<string>
}

export type RenderedDocument = {
  readonly blocks: ReadonlyArray<RenderBlock>
  readonly sources: ReadonlyArray<BlockSource>
}

const itemContainer = (list: Node, item: Node, index: number): Container => {
  if (list.type.name === "orderedList")
    return { kind: "ordered", number: Number(list.attrs["start"] ?? 1) + index, first: true }
  if (list.type.name === "taskList") return { kind: "task", checked: item.attrs["checked"] === true, first: true }
  return { kind: "bullet", first: true }
}

const quoteContainer = (node: Node): Container =>
  node.type.name === "callout"
    ? { kind: "callout", tone: calloutTone(node.attrs["tone"]), first: true, last: false }
    : { kind: "quote" }

export function renderNodes(
  nodes: ReadonlyArray<Node>,
  { start = 0, top = 0, decorate = PLAIN, taken = new Set<string>() }: RenderOptions = {},
): RenderedDocument {
  const blocks: RenderBlock[] = []
  const sources: BlockSource[] = []
  const frames: Frame[] = []
  let topIndex = top

  const emit = (node: Node, pos: number) => {
    const containers = frames.map(({ container, emitted }): Container => {
      if (container.kind === "quote") return container
      return { ...container, first: emitted === 0 }
    })
    const body = bodyOf(node, decorate)
    const id = blockId(node, body, containers)
    for (const frame of frames) {
      frame.emitted++
      frame.lastIndex = blocks.length
    }
    blocks.push({ ...body, id, containers } as RenderBlock)
    sources.push({ node, pos, top: topIndex, owners: frames.map((frame) => frame.owner) })
  }

  const markCalloutEnd = (frame: Frame, depth: number) => {
    const last = blocks[frame.lastIndex]
    if (frame.container.kind !== "callout" || last === undefined) return
    const containers = last.containers.map((container, at) =>
      at === depth && container.kind === "callout" ? { ...container, last: true } : container,
    )
    blocks[frame.lastIndex] = { ...last, id: `${last.id}~${depth}`, containers } as RenderBlock
  }

  const inside = (container: Container, owner: Node, pos: number) => {
    const frame: Frame = { container, owner: pos, emitted: 0, lastIndex: -1 }
    frames.push(frame)
    owner.forEach((child, offset) => walk(child, pos + 1 + offset))
    frames.pop()
    markCalloutEnd(frame, frames.length)
  }

  const walk = (node: Node, pos: number) => {
    const name = node.type.name
    if (name === "blockquote" || name === "callout") return inside(quoteContainer(node), node, pos)
    if (name === "bulletList" || name === "orderedList" || name === "taskList")
      return node.forEach((item, offset, index) => inside(itemContainer(node, item, index), item, pos + 1 + offset))
    emit(node, pos)
  }

  let pos = start
  for (const node of nodes) {
    walk(node, pos)
    pos += node.nodeSize
    topIndex++
  }
  const seen = new Set(taken)
  const unique = blocks.map((block) => {
    let id = block.id
    for (let copy = 2; seen.has(id); copy++) id = `${block.id}#${copy}`
    seen.add(id)
    return id === block.id ? block : ({ ...block, id } as RenderBlock)
  })
  return { blocks: unique, sources }
}

export const topLevelNodes = (doc: Node | null) => {
  const nodes: Node[] = []
  doc?.forEach((node) => void nodes.push(node))
  return nodes
}

export const renderBlocks = (doc: Node, decorate: Decorate = PLAIN) => renderNodes(topLevelNodes(doc), { decorate })
