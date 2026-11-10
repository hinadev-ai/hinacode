import type { JSONContent, MarkdownToken } from "@tiptap/core"
import type { Node } from "@tiptap/pm/model"
import { createDocumentMarkdown } from "./schema.ts"

export type ParsedDocument = {
  readonly doc: Node
  readonly lossy: boolean
}

export type DocumentMarkdown = ReturnType<typeof createDocumentMarkdown>

const FIRST_WINDOW = 2048
const WINDOW = 8192
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m

let shared: DocumentMarkdown | null = null
export const documentMarkdownManager = () => (shared ??= createDocumentMarkdown())

const isSpace = (token: MarkdownToken) => token.type === "space"

const lastBlock = (tokens: ReadonlyArray<MarkdownToken>) => tokens.findLastIndex((token) => !isSpace(token))

const withoutTrailingSeparator = (tokens: MarkdownToken[]) => {
  const last = lastBlock(tokens)
  const block = tokens[last]
  if (block === undefined) return []
  return [...tokens.slice(0, last), { ...block, raw: (block.raw ?? "").replace(/\n+$/, "") }]
}

const isCleanSeparator = (source: string, at: number) =>
  source.startsWith("\n\n", at - 2) && source[at - 3] !== "\n" && source[at] !== "\n"

const tokenStarts = (source: string, tokens: ReadonlyArray<MarkdownToken>) => {
  const starts: number[] = []
  let length = 0
  for (const token of tokens) {
    const raw = token.raw ?? ""
    if (!source.startsWith(raw, length)) break
    starts.push(length)
    length += raw.length
  }
  return starts
}

const isCut = (source: string, tokens: ReadonlyArray<MarkdownToken>, index: number, at: number) =>
  index > 0 && index <= lastBlock(tokens) && !isSpace(tokens[index]!) && isCleanSeparator(source, at)

function lastCut(source: string, tokens: ReadonlyArray<MarkdownToken>) {
  const starts = tokenStarts(source, tokens)
  for (let index = starts.length - 1; index > 0; index--)
    if (isCut(source, tokens, index, starts[index]!)) return { at: starts[index]!, count: index }
  return null
}

function cutAt(source: string, tokens: ReadonlyArray<MarkdownToken>, at: number) {
  const index = tokenStarts(source, tokens).indexOf(at)
  return isCut(source, tokens, index, at) ? index : null
}

export type DocumentChunk = {
  readonly start: number
  readonly next: number
  readonly seen: number
  readonly source: string
  readonly tokens: MarkdownToken[]
}

export type ChunkStep = { readonly chunk: DocumentChunk; readonly previous: number | null }

export type PreviousChunks = { readonly source: string; readonly chunks: ReadonlyArray<DocumentChunk> }

const SCAN_BLOCK = 1024

const commonPrefix = (a: string, b: string) => {
  const limit = Math.min(a.length, b.length)
  let length = 0
  while (length + SCAN_BLOCK <= limit && b.startsWith(a.slice(length, length + SCAN_BLOCK), length))
    length += SCAN_BLOCK
  while (length < limit && a.charCodeAt(length) === b.charCodeAt(length)) length++
  return length
}

const commonSuffix = (a: string, b: string, limit: number) => {
  let length = 0
  while (
    length + SCAN_BLOCK <= limit &&
    b.endsWith(a.slice(a.length - length - SCAN_BLOCK, a.length - length), b.length - length)
  )
    length += SCAN_BLOCK
  while (length < limit && a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)) length++
  return length
}

const shifted = (chunk: DocumentChunk, delta: number): DocumentChunk => ({
  ...chunk,
  start: chunk.start + delta,
  next: chunk.next + delta,
  seen: chunk.seen + delta,
})

export function* documentChunks(
  { markdown }: DocumentMarkdown,
  source: string,
  previous?: PreviousChunks,
): Generator<ChunkStep> {
  const lex = (text: string) => markdown.instance.lexer(text)
  if (REFERENCE_DEFINITION.test(source)) {
    yield {
      chunk: { start: 0, next: source.length, seen: source.length + 1, source, tokens: lex(source) },
      previous: null,
    }
    return
  }
  const old = previous?.chunks ?? []
  const prefix = previous === undefined ? 0 : commonPrefix(previous.source, source)
  const delta = source.length - (previous?.source.length ?? 0)
  const suffixStart =
    previous === undefined
      ? Infinity
      : previous.source.length -
        commonSuffix(previous.source, source, Math.min(previous.source.length, source.length) - prefix)
  let at = 0
  let index = 0
  for (; index < old.length && old[index]!.start === at && old[index]!.seen <= prefix; index++) {
    yield { chunk: old[index]!, previous: index }
    at = old[index]!.next
  }
  let window = at === 0 ? FIRST_WINDOW : WINDOW
  while (at < source.length) {
    const anchor = old.findIndex(
      (chunk, candidate) => candidate >= index && chunk.start >= suffixStart && chunk.start + delta > at,
    )
    if (anchor !== -1) {
      const next = old[anchor]!
      const boundary = next.start + delta
      const firstBlock = next.tokens.find((token) => !isSpace(token))?.raw?.length ?? next.source.length
      const end = Math.min(source.length, boundary + firstBlock)
      const slice = source.slice(at, end)
      const tokens = lex(slice)
      const count = cutAt(slice, tokens, boundary - at)
      if (count !== null) {
        yield {
          chunk: {
            start: at,
            next: boundary,
            seen: end,
            source: slice.slice(0, boundary - at - 2),
            tokens: withoutTrailingSeparator(tokens.slice(0, count)),
          },
          previous: null,
        }
        for (let reused = anchor; reused < old.length; reused++)
          yield { chunk: shifted(old[reused]!, delta), previous: reused }
        return
      }
    }
    const cut = at + window >= source.length ? -1 : source.indexOf("\n\n", at + window)
    if (cut === -1) {
      const rest = source.slice(at)
      yield {
        chunk: { start: at, next: source.length, seen: source.length + 1, source: rest, tokens: lex(rest) },
        previous: null,
      }
      return
    }
    const slice = source.slice(at, cut)
    const tokens = lex(slice)
    const found = lastCut(slice, tokens)
    if (found === null) {
      window *= 2
      continue
    }
    yield {
      chunk: {
        start: at,
        next: at + found.at,
        seen: cut,
        source: slice.slice(0, found.at - 2),
        tokens: withoutTrailingSeparator(tokens.slice(0, found.count)),
      },
      previous: null,
    }
    at += found.at
    window = WINDOW
  }
}

const asPlainParagraphs = (source: string): JSONContent[] =>
  source
    .split(/\n{2,}/)
    .filter((part) => part.trim() !== "")
    .map((part) => ({ type: "paragraph", content: [{ type: "text", text: part }] }))

// FIXME: MarkdownManager.parseTokens is public at runtime but typed private, and parse() would lex every chunk again.
const parseTokens = (manager: DocumentMarkdown, tokens: MarkdownToken[]) =>
  (
    manager.markdown as unknown as { parseTokens: (tokens: MarkdownToken[], implicit: boolean) => JSONContent[] }
  ).parseTokens(tokens, true)

export function chunkNodes(manager: DocumentMarkdown, chunk: Pick<DocumentChunk, "source" | "tokens">) {
  const toNodes = (content: JSONContent[]) => content.map((node) => manager.schema.nodeFromJSON(node))
  try {
    return { nodes: toNodes(parseTokens(manager, chunk.tokens)), lossy: false }
  } catch {
    return { nodes: toNodes(asPlainParagraphs(chunk.source)), lossy: true }
  }
}

export function parseDocument(source: string, manager: DocumentMarkdown = documentMarkdownManager()): ParsedDocument {
  const nodes: Node[] = []
  let lossy = false
  for (const { chunk } of documentChunks(manager, source)) {
    const parsed = chunkNodes(manager, chunk)
    nodes.push(...parsed.nodes)
    lossy ||= parsed.lossy
  }
  const { topNodeType } = manager.schema
  return { doc: nodes.length === 0 ? topNodeType.createAndFill()! : topNodeType.create(null, nodes), lossy }
}

export const serializeDocument = (doc: Node, manager: DocumentMarkdown = documentMarkdownManager()) =>
  manager.markdown.serialize(doc.toJSON())
