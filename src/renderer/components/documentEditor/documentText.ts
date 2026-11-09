import type { Node } from "@tiptap/pm/model"
import type { TextRange } from "../../../shared/textAnchor.ts"

type Run = { readonly offset: number; readonly position: number; readonly length: number }

export type DocumentText = {
  readonly text: string
  readonly textRange: (range: TextRange) => TextRange
  readonly documentRange: (range: TextRange) => TextRange
}

const BLOCK_BREAK = "\n"

const runEnd = (run: Run) => run.offset + run.length

export const documentText = (doc: Node): DocumentText => {
  const runs: Array<Run> = []
  let text = ""
  doc.descendants((node, position) => {
    if (node.isTextblock && text !== "") text += BLOCK_BREAK
    if (node.isText && node.text !== undefined) {
      runs.push({ offset: text.length, position, length: node.text.length })
      text += node.text
    }
    return true
  })

  const offsetAfter = (position: number) => {
    const run = runs.find((candidate) => candidate.position + candidate.length > position)
    if (run === undefined) return text.length
    return run.offset + Math.max(0, position - run.position)
  }
  const offsetBefore = (position: number) => {
    const run = runs.findLast((candidate) => candidate.position < position)
    if (run === undefined) return 0
    return run.offset + Math.min(run.length, position - run.position)
  }
  const positionAfter = (offset: number) => {
    const run = runs.find((candidate) => runEnd(candidate) > offset)
    if (run === undefined) return doc.content.size
    return run.position + Math.max(0, offset - run.offset)
  }
  const positionBefore = (offset: number) => {
    const run = runs.findLast((candidate) => candidate.offset < offset)
    if (run === undefined) return 0
    return run.position + Math.min(run.length, offset - run.offset)
  }

  return {
    text,
    textRange: ({ from, to }) => ({ from: offsetAfter(from), to: Math.max(offsetAfter(from), offsetBefore(to)) }),
    documentRange: ({ from, to }) => ({
      from: positionAfter(from),
      to: Math.max(positionAfter(from), positionBefore(to)),
    }),
  }
}
