import type { Node } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import {
  chunkNodes,
  type DocumentChunk,
  documentChunks,
  serializeDocument,
} from "../../../src/shared/document/parse.ts"
import { type SelectionState, selectionState } from "./actions.ts"
import type { BlockPatch, CodeToken, DiagramDrawing, RenderBlock, TextPoint, TextRange } from "./blocks.ts"
import { createDocumentEngine, type DocumentEngine, type StructuralKey } from "./engine.ts"
import { appendPatch, diffBlocks } from "./patch.ts"
import { type BlockSource, type Decorate, renderNodes, topLevelNodes } from "./renderBlocks.ts"
import { pointOf, positionOf } from "./textPoints.ts"

export type SessionOptions = {
  readonly send: (patch: BlockPatch) => void
  readonly schedule: (run: () => void) => void
  readonly now: () => number
  readonly sliceMs?: number
  readonly restSliceMs?: number
  readonly highlight?: (text: string, language: string) => ReadonlyArray<CodeToken>
  readonly drawDiagram?: (source: string) => Promise<DiagramDrawing | null>
  readonly onEdited?: () => void
  readonly onSelection?: (selection: SelectionState) => void
  readonly engine?: DocumentEngine
}

export type TextEdit = {
  readonly eventCount: number
  readonly block: number
  readonly cell: readonly [number, number] | null
  readonly from: number
  readonly to: number
  readonly text: string
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

type Hunk = { readonly before: number; readonly beforeEnd: number; readonly after: number; readonly afterEnd: number }

const sizeOf = (nodes: ReadonlyArray<Node>, from: number, to: number) => {
  let size = 0
  for (let index = from; index < to; index++) size += nodes[index]!.nodeSize
  return size
}

const changedHunks = (before: ReadonlyArray<Node>, after: ReadonlyArray<Node>): Hunk[] => {
  const oldIndex = new Map<Node, number>()
  before.forEach((node, index) => oldIndex.set(node, index))
  const hunks: Hunk[] = []
  let oldCursor = 0
  let newCursor = 0
  for (let index = 0; index < after.length; index++) {
    const match = oldIndex.get(after[index]!)
    if (match === undefined || match < oldCursor) continue
    if (match > oldCursor || index > newCursor)
      hunks.push({ before: oldCursor, beforeEnd: match, after: newCursor, afterEnd: index })
    oldCursor = match + 1
    newCursor = index + 1
  }
  if (oldCursor < before.length || newCursor < after.length)
    hunks.push({ before: oldCursor, beforeEnd: before.length, after: newCursor, afterEnd: after.length })
  return hunks
}

export function createDocumentSession({
  send,
  schedule,
  now,
  sliceMs = 8,
  restSliceMs = 32,
  highlight,
  drawDiagram,
  onEdited,
  onSelection,
  engine = createDocumentEngine(),
}: SessionOptions) {
  const { manager, editor } = engine
  let blocks: RenderBlock[] = []
  let sources: BlockSource[] = []
  let parsed: {
    readonly markdown: string
    readonly chunks: ReadonlyArray<{
      readonly chunk: DocumentChunk
      readonly nodes: ReadonlyArray<Node>
      readonly lossy: boolean
    }>
  } | null = null
  let loaded = false
  let lossy = false
  let revision = 0
  let eventCount = 0
  const drawings = new Map<string, DiagramDrawing | null>()
  const decorate: Decorate = { code: highlight, drawing: (source) => drawings.get(source) ?? undefined }

  const show = (patch: BlockPatch) => {
    blocks.splice(patch.start, patch.deleteCount, ...patch.insert)
    send(patch)
  }

  const takenOutside = (start: number, end: number) => {
    const taken = new Set<string>()
    for (let index = 0; index < blocks.length; index++) if (index < start || index >= end) taken.add(blocks[index]!.id)
    return taken
  }

  const blockRangeOf = (topStart: number, topEnd: number) => {
    let start = sources.findIndex((source) => source.top >= topStart)
    if (start === -1) start = sources.length
    let end = start
    while (end < sources.length && sources[end]!.top < topEnd) end++
    return { start, end }
  }

  const rerenderHunk = (newTop: ReadonlyArray<Node>, hunk: Hunk, sizeDelta: number) => {
    const { start, end } = blockRangeOf(hunk.after, hunk.after + hunk.beforeEnd - hunk.before)
    let position = 0
    for (let index = 0; index < hunk.after; index++) position += newTop[index]!.nodeSize
    const rendered = renderNodes(newTop.slice(hunk.after, hunk.afterEnd), {
      start: position,
      top: hunk.after,
      decorate,
      taken: takenOutside(start, end),
    })
    const topDelta = hunk.afterEnd - hunk.after - (hunk.beforeEnd - hunk.before)
    for (let index = end; index < sources.length; index++) {
      const source = sources[index]!
      source.pos += sizeDelta
      source.top += topDelta
      for (let owner = 0; owner < source.owners.length; owner++) source.owners[owner]! += sizeDelta
    }
    sources.splice(start, end - start, ...rendered.sources)
    const patch = diffBlocks(blocks.slice(start, end), rendered.blocks, revision, eventCount)
    if (patch !== null) show({ ...patch, start: patch.start + start })
  }

  const rerender = (before: Node, after: Node, selection?: () => TextRange | undefined) => {
    const oldTop = topLevelNodes(before)
    const newTop = topLevelNodes(after)
    for (const hunk of changedHunks(oldTop, newTop))
      rerenderHunk(
        newTop,
        hunk,
        sizeOf(newTop, hunk.after, hunk.afterEnd) - sizeOf(oldTop, hunk.before, hunk.beforeEnd),
      )
    const placed = selection?.()
    if (placed !== undefined) show({ revision, eventCount, start: 0, deleteCount: 0, insert: [], selection: placed })
  }

  const replaceAll = (doc: Node) => {
    const rendered = renderNodes(topLevelNodes(doc), { decorate })
    sources = [...rendered.sources]
    const patch = diffBlocks(blocks, rendered.blocks, revision, eventCount)
    if (patch !== null) show(patch)
  }

  const drawMissingDiagrams = () => {
    if (drawDiagram === undefined) return
    for (const block of blocks) {
      if (block.kind !== "diagram" || drawings.has(block.source)) continue
      const { source } = block
      drawings.set(source, null)
      void drawDiagram(source)
        .catch(() => null)
        .then((drawing) => {
          if (drawing === null) return
          drawings.set(source, drawing)
          replaceAll(editor.state.doc)
        })
    }
  }

  const load = (markdown: string, onLoaded?: () => void) => {
    const loadRevision = ++revision
    const previous = parsed
    const progressive = blocks.length === 0
    const records: { chunk: DocumentChunk; nodes: ReadonlyArray<Node>; lossy: boolean }[] = []
    const nodes: Node[] = []
    const iterator = documentChunks(
      manager,
      markdown,
      previous === null ? undefined : { source: previous.markdown, chunks: previous.chunks.map(({ chunk }) => chunk) },
    )
    const shownIds = new Set<string>()
    let pending: RenderBlock[] = []
    let firstScreen = true
    let offset = 0
    let top = 0
    if (progressive) sources = []

    const take = ({ chunk, previous: index }: { chunk: DocumentChunk; previous: number | null }) => {
      const record =
        index === null || previous === null
          ? { chunk, ...chunkNodes(manager, chunk) }
          : { ...previous.chunks[index]!, chunk }
      records.push(record)
      nodes.push(...record.nodes)
      if (!progressive) return
      const rendered = renderNodes(record.nodes, { start: offset, top, decorate, taken: shownIds })
      for (const node of record.nodes) offset += node.nodeSize
      top += record.nodes.length
      sources.push(...rendered.sources)
      for (const block of rendered.blocks) shownIds.add(block.id)
      pending.push(...rendered.blocks)
    }

    const flush = () => {
      if (pending.length === 0) return
      show(appendPatch(blocks.length, pending, loadRevision))
      pending = []
      firstScreen = false
    }

    const finish = () => {
      flush()
      const { topNodeType } = manager.schema
      const kept = progressive ? nodes : keepUnchanged(loaded ? topLevelNodes(editor.state.doc) : [], nodes)
      const doc = kept.length === 0 ? topNodeType.createAndFill()! : topNodeType.create(null, kept)
      const before = loaded ? editor.state.doc : null
      engine.load(doc)
      if (before !== null && !progressive) rerender(before, doc)
      else if (!progressive || kept.length === 0) replaceAll(doc)
      parsed = { markdown, chunks: records }
      lossy = records.some((record) => record.lossy)
      loaded = true
      drawMissingDiagrams()
      onLoaded?.()
    }

    const step = () => {
      if (loadRevision !== revision) return
      const deadline = now() + (firstScreen ? sliceMs : restSliceMs)
      for (;;) {
        const next = iterator.next()
        if (next.done === true) return finish()
        take(next.value)
        if (firstScreen) flush()
        if (now() >= deadline) {
          flush()
          return schedule(step)
        }
      }
    }
    step()
  }

  const selectionRange = (): TextRange | undefined => {
    const { anchor, head } = editor.state.selection
    const anchorPoint = pointOf(sources, anchor)
    const headPoint = pointOf(sources, head)
    return anchorPoint === null || headPoint === null ? undefined : { anchor: anchorPoint, head: headPoint }
  }

  const change = (run: () => unknown, placeSelection: boolean) => {
    if (!loaded) return false
    const before = editor.state.doc
    const result = run()
    const after = editor.state.doc
    if (after !== before) {
      rerender(before, after, placeSelection ? selectionRange : undefined)
      onEdited?.()
    } else if (placeSelection) {
      const selection = selectionRange()
      if (selection !== undefined) show({ revision, eventCount, start: 0, deleteCount: 0, insert: [], selection })
    }
    onSelection?.(selectionState(editor))
    return result !== false
  }

  const positionAt = (point: TextPoint) => {
    const source = sources[point.block]
    return source === undefined ? null : positionOf(source, point.cell, point.offset)
  }

  return {
    load,
    edit: ({ eventCount: count, block, cell, from, to, text }: TextEdit) => {
      eventCount = Math.max(eventCount, count)
      const start = positionAt({ block, cell, offset: from })
      const end = positionAt({ block, cell, offset: to })
      if (start === null || end === null) return false
      return change(() => {
        const tr = editor.state.tr
        if (text === "") tr.delete(start, end)
        else tr.insertText(text, start, end)
        engine.dispatch(tr)
      }, false)
    },
    select: ({ anchor, head }: TextRange) => {
      const from = positionAt(anchor)
      const to = positionAt(head)
      if (!loaded || from === null || to === null) return
      engine.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
      onSelection?.(selectionState(editor))
    },
    press: (key: StructuralKey, shift: boolean, count: number) => {
      eventCount = Math.max(eventCount, count)
      return change(() => engine.press(key, shift), true)
    },
    toggleTask: (block: number) => {
      const source = sources[block]
      const doc = editor.state.doc
      const owner = source?.owners.findLast((pos) => doc.nodeAt(pos)?.type.name === "taskItem")
      if (owner === undefined) return false
      return change(() => {
        const item = doc.nodeAt(owner)!
        engine.dispatch(
          editor.state.tr.setNodeMarkup(owner, undefined, { ...item.attrs, checked: !item.attrs["checked"] }),
        )
      }, false)
    },
    run: (command: () => boolean) => change(command, true),
    markdown: () => serializeDocument(editor.state.doc, manager),
    get editor() {
      return editor
    },
    get loaded() {
      return loaded
    },
    get lossy() {
      return lossy
    },
    get blocks() {
      return blocks
    },
    get sources() {
      return sources
    },
    get doc() {
      return loaded ? editor.state.doc : null
    },
  }
}

export type DocumentSession = ReturnType<typeof createDocumentSession>
