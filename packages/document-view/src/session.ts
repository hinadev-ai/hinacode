import type { Node } from "@tiptap/pm/model"
import { chunkNodes, documentChunks, documentMarkdownManager } from "../../../src/shared/document/parse.ts"
import type { BlockPatch, RenderBlock } from "./blocks.ts"
import { appendPatch, diffBlocks } from "./patch.ts"
import { type BlockSource, renderNodes } from "./renderBlocks.ts"

export type SessionOptions = {
  readonly send: (patch: BlockPatch) => void
  readonly schedule: (run: () => void) => void
  readonly now: () => number
  readonly sliceMs?: number
}

type Loaded = {
  readonly doc: Node | null
  readonly lossy: boolean
  readonly blocks: ReadonlyArray<RenderBlock>
  readonly sources: ReadonlyArray<BlockSource>
  readonly chunks: ReadonlyMap<string, ReadonlyArray<Node>>
}

const keepUnchanged = (before: ReadonlyArray<Node>, after: Node[]) => {
  const shorter = Math.min(before.length, after.length)
  let start = 0
  while (start < shorter && before[start]!.eq(after[start]!)) after[start] = before[start++]!
  for (let tail = 1; tail <= shorter - start; tail++) {
    const old = before[before.length - tail]!
    if (!old.eq(after[after.length - tail]!)) break
    after[after.length - tail] = old
  }
  return after
}

const topLevel = (doc: Node | null) => {
  const nodes: Node[] = []
  doc?.forEach((node) => void nodes.push(node))
  return nodes
}

export function createDocumentSession({ send, schedule, now, sliceMs = 8 }: SessionOptions) {
  const manager = documentMarkdownManager()
  let current: Loaded = { doc: null, lossy: false, blocks: [], sources: [], chunks: new Map() }
  let revision = 0
  let shown: RenderBlock[] = []

  const show = (patch: BlockPatch) => {
    shown.splice(patch.start, patch.deleteCount, ...patch.insert)
    send(patch)
  }

  const load = (markdown: string, onLoaded?: () => void) => {
    const loadRevision = ++revision
    const reused = current.chunks
    const progressive = shown.length === 0
    const chunks = new Map<string, ReadonlyArray<Node>>()
    const nodes: Node[] = []
    const blocks: RenderBlock[] = []
    const sources: BlockSource[] = []
    const iterator = documentChunks(manager, markdown)
    let offset = 0
    let lossy = false

    const take = (chunk: Parameters<typeof chunkNodes>[1]) => {
      let parsed = reused.get(chunk.source)
      if (parsed === undefined) {
        const result = chunkNodes(manager, chunk)
        parsed = result.nodes
        lossy ||= result.lossy
      }
      chunks.set(chunk.source, parsed)
      nodes.push(...parsed)
      if (!progressive) return
      const rendered = renderNodes(parsed, offset)
      for (const node of parsed) offset += node.nodeSize
      if (rendered.blocks.length > 0) show(appendPatch(blocks.length, rendered.blocks, loadRevision))
      blocks.push(...rendered.blocks)
      sources.push(...rendered.sources)
    }

    const finish = () => {
      const { topNodeType } = manager.schema
      const kept = progressive ? nodes : keepUnchanged(topLevel(current.doc), nodes)
      const doc = kept.length === 0 ? topNodeType.createAndFill()! : topNodeType.create(null, kept)
      if (!progressive || kept.length === 0) {
        const rendered = renderNodes(topLevel(doc))
        blocks.splice(0, blocks.length, ...rendered.blocks)
        sources.splice(0, sources.length, ...rendered.sources)
        const patch = diffBlocks(shown, blocks, loadRevision)
        if (patch !== null) show(patch)
      }
      current = { doc, lossy, blocks, sources, chunks }
      onLoaded?.()
    }

    const step = () => {
      if (loadRevision !== revision) return
      const deadline = now() + sliceMs
      for (;;) {
        const next = iterator.next()
        if (next.done === true) return finish()
        take(next.value)
        if (now() >= deadline) return schedule(step)
      }
    }
    step()
  }

  return {
    load,
    get doc() {
      return current.doc
    },
    get lossy() {
      return current.lossy
    },
    get blocks() {
      return current.blocks
    },
    get sources() {
      return current.sources
    },
  }
}

export type DocumentSession = ReturnType<typeof createDocumentSession>
