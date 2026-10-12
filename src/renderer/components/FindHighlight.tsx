import { createContext, type ReactNode, useContext } from "react"

/** What the open find bar searches for, or null when nothing in the transcript should be marked. */
export const FindPatternContext = createContext<RegExp | null>(null)

export const useFindPattern = () => useContext(FindPatternContext)

/** The find bar picks its current match by counting these in a message, in document order. */
export const MATCH_SELECTOR = "mark[data-find-match]"

export const markClassName =
  "rounded-[2px] bg-find-match text-inherit transition-[background-color,outline-color] duration-150 ease-out outline-1 outline-transparent data-current:bg-find-match-current data-current:outline-find-match-ring motion-reduce:transition-none"

/** Splits `text` into plain runs and `<mark>`s around every match. */
export function highlight(text: string, pattern: RegExp | null): ReactNode {
  if (pattern === null) return text
  const nodes: Array<ReactNode> = []
  let end = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) nodes.push(text.slice(end, match.index))
    nodes.push(
      <mark key={match.index} data-find-match="" className={markClassName}>
        {match[0]}
      </mark>,
    )
    end = match.index + match[0].length
  }
  if (end === 0) return text
  if (end < text.length) nodes.push(text.slice(end))
  return nodes
}

/** Plain text with the find bar's matches marked. */
export function Highlighted({ text }: { text: string }) {
  return highlight(text, useFindPattern())
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

const markNode = (value: string): HastElement => ({
  type: "element",
  tagName: "mark",
  properties: { dataFindMatch: "", className: markClassName },
  children: [{ type: "text", value }],
})

const splitText = (value: string, pattern: RegExp): Array<HastNode> | null => {
  const nodes: Array<HastNode> = []
  let end = 0
  for (const match of value.matchAll(pattern)) {
    if (match.index > end) nodes.push({ type: "text", value: value.slice(end, match.index) })
    nodes.push(markNode(match[0]))
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
export const rehypeFindMarks = (pattern: RegExp) => () => (tree: HastNode) => {
  const visit = (node: HastNode) => {
    if (!("children" in node) || node.children === undefined) return
    if (node.type === "element" && node.tagName === "pre") return
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return splitText(child.value, pattern) ?? [child]
      visit(child)
      return [child]
    })
  }
  visit(tree)
}
