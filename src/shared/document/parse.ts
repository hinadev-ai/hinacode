import type { JSONContent, MarkdownToken } from "@tiptap/core"
import type { Node } from "@tiptap/pm/model"
import { createDocumentMarkdown } from "./schema.ts"

export type ParsedDocument = {
  readonly doc: Node
  readonly lossy: boolean
}

type DocumentMarkdown = ReturnType<typeof createDocumentMarkdown>

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

function lastCut(source: string, tokens: ReadonlyArray<MarkdownToken>) {
  const starts: number[] = []
  let length = 0
  for (const token of tokens) {
    const raw = token.raw ?? ""
    if (!source.startsWith(raw, length)) break
    starts.push(length)
    length += raw.length
  }
  for (let index = Math.min(starts.length, lastBlock(tokens)); index > 0; index--) {
    const at = starts[index]!
    if (!isSpace(tokens[index]!) && isCleanSeparator(source, at)) return { at, count: index }
  }
  return null
}

export function* documentChunks(
  { markdown }: DocumentMarkdown,
  source: string,
): Generator<{ readonly source: string; readonly tokens: MarkdownToken[] }> {
  if (REFERENCE_DEFINITION.test(source)) {
    yield { source, tokens: markdown.instance.lexer(source) }
    return
  }
  let at = 0
  let window = WINDOW
  while (at < source.length) {
    const cut = at + window >= source.length ? -1 : source.indexOf("\n\n", at + window)
    if (cut === -1) {
      const rest = source.slice(at)
      yield { source: rest, tokens: markdown.instance.lexer(rest) }
      return
    }
    const slice = source.slice(at, cut)
    const tokens = markdown.instance.lexer(slice)
    const found = lastCut(slice, tokens)
    if (found === null) {
      window *= 2
      continue
    }
    yield { source: slice.slice(0, found.at - 2), tokens: withoutTrailingSeparator(tokens.slice(0, found.count)) }
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

function chunkNodes(manager: DocumentMarkdown, chunk: { source: string; tokens: MarkdownToken[] }) {
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
  for (const chunk of documentChunks(manager, source)) {
    const parsed = chunkNodes(manager, chunk)
    nodes.push(...parsed.nodes)
    lossy ||= parsed.lossy
  }
  const { topNodeType } = manager.schema
  return { doc: nodes.length === 0 ? topNodeType.createAndFill()! : topNodeType.create(null, nodes), lossy }
}

export const serializeDocument = (doc: Node, manager: DocumentMarkdown = documentMarkdownManager()) =>
  manager.markdown.serialize(doc.toJSON())
