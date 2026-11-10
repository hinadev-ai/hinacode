import type { BlockPatch, RenderBlock } from "./blocks.ts"

export function diffBlocks(
  before: ReadonlyArray<RenderBlock>,
  after: ReadonlyArray<RenderBlock>,
  revision: number,
): BlockPatch | null {
  let start = 0
  const shorter = Math.min(before.length, after.length)
  while (start < shorter && before[start]!.id === after[start]!.id) start++
  let tail = 0
  while (tail < shorter - start && before[before.length - 1 - tail]!.id === after[after.length - 1 - tail]!.id) tail++
  const deleteCount = before.length - start - tail
  const insert = after.slice(start, after.length - tail)
  if (deleteCount === 0 && insert.length === 0) return null
  return { revision, start, deleteCount, insert }
}

export function applyPatch(blocks: ReadonlyArray<RenderBlock>, patch: BlockPatch): RenderBlock[] {
  const next = blocks.slice()
  next.splice(patch.start, patch.deleteCount, ...patch.insert)
  return next
}

export const appendPatch = (count: number, insert: ReadonlyArray<RenderBlock>, revision: number): BlockPatch => ({
  revision,
  start: count,
  deleteCount: 0,
  insert,
})
