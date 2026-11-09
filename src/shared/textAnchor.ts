import type { CommentAnchor } from "./artifact.ts"

export type TextAnchor = Extract<CommentAnchor, { kind: "text" }>

export type TextRange = { readonly from: number; readonly to: number }

const CONTEXT_LENGTH = 32

export const textAnchorAt = (text: string, from: number, to: number): TextAnchor => ({
  kind: "text",
  quote: text.slice(from, to),
  prefix: text.slice(Math.max(0, from - CONTEXT_LENGTH), from),
  suffix: text.slice(to, to + CONTEXT_LENGTH),
})

const sharedEnd = (a: string, b: string) => {
  let length = 0
  while (length < a.length && length < b.length && a[a.length - 1 - length] === b[b.length - 1 - length]) length++
  return length
}

const sharedStart = (a: string, b: string) => {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length]) length++
  return length
}

const withoutInlineMarkdown = (quote: string) =>
  quote
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/(?<!\\)(\*\*|__|~~|`)/g, "")
    .replaceAll(/(?<![\\\p{L}\p{N}])[*_]|(?<!\\)[*_](?![\p{L}\p{N}])/gu, "")
    .replaceAll(/\\(\p{P})/gu, "$1")

const bestOccurrence = (text: string, quote: string, anchor: TextAnchor): TextRange | null => {
  if (quote === "") return null
  let best: TextRange | null = null
  let bestScore = -1
  for (let from = text.indexOf(quote); from !== -1; from = text.indexOf(quote, from + 1)) {
    const to = from + quote.length
    const score =
      sharedEnd(text.slice(Math.max(0, from - anchor.prefix.length), from), anchor.prefix) +
      sharedStart(text.slice(to, to + anchor.suffix.length), anchor.suffix)
    if (score > bestScore) {
      best = { from, to }
      bestScore = score
    }
  }
  return best
}

export const resolveTextAnchor = (text: string, anchor: TextAnchor): TextRange | null =>
  bestOccurrence(text, anchor.quote, anchor) ?? bestOccurrence(text, withoutInlineMarkdown(anchor.quote), anchor)
