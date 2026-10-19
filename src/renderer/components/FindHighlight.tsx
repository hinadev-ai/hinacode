import { createContext, type ReactNode, useContext } from "react"

/** What the open find bar searches for, or null when nothing in the transcript should be marked. */
export const FindPatternContext = createContext<RegExp | null>(null)

export const useFindPattern = () => useContext(FindPatternContext)

/**
 * The transcript part a subtree renders, stamped on its marks as `data-find-part`. The find bar picks
 * its current match by position among its part's marks, so hidden or repeated text elsewhere in the
 * message cannot shift it. Marks outside any part, like a command group's running line, are never picked.
 */
export const FindPartContext = createContext<number | null>(null)

/** The marks of part `partIndex` within a message's row. */
export const partMatchSelector = (partIndex: number) => `mark[data-find-match][data-find-part="${partIndex}"]`

export const markClassName =
  "rounded-[2px] bg-find-match text-inherit transition-[background-color,outline-color] duration-150 ease-out outline-1 outline-transparent data-current:bg-find-match-current data-current:outline-find-match-ring motion-reduce:transition-none"

/** Splits `text` into plain runs and `<mark>`s around every match. */
export function highlight(text: string, pattern: RegExp | null, part: number | null = null): ReactNode {
  if (pattern === null) return text
  const nodes: Array<ReactNode> = []
  let end = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) nodes.push(text.slice(end, match.index))
    nodes.push(
      <mark key={match.index} data-find-match="" data-find-part={part ?? undefined} className={markClassName}>
        {match[0]}
      </mark>,
    )
    end = match.index + match[0].length
  }
  if (end === 0) return text
  if (end < text.length) nodes.push(text.slice(end))
  return nodes
}

/** A run of text in one color, like a syntax token. */
export interface Run {
  readonly text: string
  readonly color?: string
}

/**
 * Colored runs with the find bar's matches marked. A match across several runs gets one `<mark>`, because the find
 * bar picks its current match by position among the marks.
 */
export function highlightRuns(runs: ReadonlyArray<Run>, pattern: RegExp | null, part: number | null): ReactNode {
  const text = runs.map((run) => run.text).join("")
  const matches = pattern === null ? [] : [...text.matchAll(pattern)].filter((match) => match[0] !== "")
  const nodes: Array<ReactNode> = []
  let mark: Array<ReactNode> = []
  let next = 0
  let offset = 0
  const closeMark = () => {
    const match = matches[next++]
    nodes.push(
      <mark key={`m${match?.index}`} data-find-match="" data-find-part={part ?? undefined} className={markClassName}>
        {mark}
      </mark>,
    )
    mark = []
  }
  runs.forEach((run, index) => {
    let start = 0
    while (start < run.text.length) {
      const match = matches[next]
      const matchStart = (match?.index ?? Infinity) - offset
      const matchEnd = matchStart + (match?.[0].length ?? 0)
      const inMatch = matchStart <= start
      const end = Math.min(run.text.length, inMatch ? matchEnd : matchStart)
      const span = (
        <span key={`${index}:${start}`} style={{ color: run.color }}>
          {run.text.slice(start, end)}
        </span>
      )
      if (inMatch) mark.push(span)
      else nodes.push(span)
      if (inMatch && end === matchEnd) closeMark()
      start = end
    }
    offset += run.text.length
  })
  return nodes
}

/** Plain text with the find bar's matches marked. */
export function Highlighted({ text }: { text: string }) {
  return highlight(text, useFindPattern(), useContext(FindPartContext))
}

interface HastText {
  readonly type: "text"
  readonly value: string
}
interface HastElement {
  readonly type: "element"
  readonly tagName: string
  readonly properties: Record<string, unknown>
  children: Array<HastNode>
}
type HastNode =
  | HastText
  | HastElement
  | { readonly type: "root" | "comment" | "doctype" | "raw"; children?: Array<HastNode> }

const markNode = (value: string, part: number | null): HastElement => ({
  type: "element",
  tagName: "mark",
  properties: { dataFindMatch: "", dataFindPart: part ?? undefined, className: markClassName },
  children: [{ type: "text", value }],
})

const splitText = (value: string, pattern: RegExp, part: number | null): Array<HastNode> | null => {
  const nodes: Array<HastNode> = []
  let end = 0
  for (const match of value.matchAll(pattern)) {
    if (match.index > end) nodes.push({ type: "text", value: value.slice(end, match.index) })
    nodes.push(markNode(match[0], part))
    end = match.index + match[0].length
  }
  if (end === 0) return null
  if (end < value.length) nodes.push({ type: "text", value: value.slice(end) })
  return nodes
}

/**
 * A rehype plugin that marks matches in rendered markdown text. Fenced code is skipped here because
 * `Markdown` renders it from the raw source and marks it with `Highlighted`.
 */
export const rehypeFindMarks = (pattern: RegExp, part: number | null) => () => (tree: HastNode) => {
  const visit = (node: HastNode) => {
    if (!("children" in node) || node.children === undefined) return
    if (node.type === "element" && node.tagName === "pre") return
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return splitText(child.value, pattern, part) ?? [child]
      visit(child)
      return [child]
    })
  }
  visit(tree)
}
