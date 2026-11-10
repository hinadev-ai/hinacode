import type { Node } from "@tiptap/pm/model"
import type { TextPoint } from "./blocks.ts"
import type { BlockSource } from "./renderBlocks.ts"

type Segment = { readonly start: number; readonly size: number }

const textblocksIn = (node: Node, pos: number): Segment[] => {
  const segments: Segment[] = []
  node.descendants((child, offset) => {
    if (!child.isTextblock) return true
    segments.push({ start: pos + 1 + offset + 1, size: child.content.size })
    return false
  })
  return segments
}

const cellAt = (table: Node, tablePos: number, [row, column]: readonly [number, number]) => {
  const rowNode = table.maybeChild(row)
  const cellNode = rowNode?.maybeChild(column)
  if (rowNode === undefined || rowNode === null || cellNode === undefined || cellNode === null) return null
  let pos = tablePos + 1
  for (let index = 0; index < row; index++) pos += table.child(index).nodeSize
  pos += 1
  for (let index = 0; index < column; index++) pos += rowNode.child(index).nodeSize
  return { node: cellNode, pos }
}

const segmentsOf = (source: BlockSource, cell: readonly [number, number] | null): Segment[] => {
  if (source.node.isTextblock) return [{ start: source.pos + 1, size: source.node.content.size }]
  if (source.node.type.name !== "table" || cell === null) return []
  const found = cellAt(source.node, source.pos, cell)
  return found === null ? [] : textblocksIn(found.node, found.pos)
}

export function positionOf(source: BlockSource, cell: readonly [number, number] | null, offset: number) {
  const segments = segmentsOf(source, cell)
  let remaining = Math.max(0, offset)
  for (const [index, { start, size }] of segments.entries()) {
    if (remaining <= size || index === segments.length - 1) return start + Math.min(remaining, size)
    remaining -= size + 1
  }
  return null
}

const lastSourceAtOrBefore = (sources: ReadonlyArray<BlockSource>, pos: number) => {
  let low = 0
  let high = sources.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (sources[middle]!.pos <= pos) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

export function pointOf(sources: ReadonlyArray<BlockSource>, pos: number): TextPoint | null {
  const block = lastSourceAtOrBefore(sources, pos - 1)
  const source = sources[block]
  if (source === undefined) return null
  if (source.node.isTextblock)
    return { block, cell: null, offset: Math.max(0, Math.min(pos - source.pos - 1, source.node.content.size)) }
  if (source.node.type.name !== "table") return { block, cell: null, offset: 0 }
  let rowPos = source.pos + 1
  for (let row = 0; row < source.node.childCount; row++) {
    const rowNode = source.node.child(row)
    let cellPos = rowPos + 1
    for (let column = 0; column < rowNode.childCount; column++) {
      const cellNode = rowNode.child(column)
      if (pos >= cellPos && pos <= cellPos + cellNode.nodeSize) {
        let offset = 0
        for (const { start, size } of textblocksIn(cellNode, cellPos)) {
          if (pos <= start + size) return { block, cell: [row, column], offset: offset + Math.max(0, pos - start) }
          offset += size + 1
        }
        return { block, cell: [row, column], offset }
      }
      cellPos += cellNode.nodeSize
    }
    rowPos += rowNode.nodeSize
  }
  return { block, cell: null, offset: 0 }
}
