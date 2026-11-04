import { Schema } from "effect"
import { CALLOUT_TONES, calloutTone } from "./documentCallout.ts"

export const OutlineBlock = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("heading"), level: Schema.Literals([1, 2, 3]), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("text"), length: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("list"), items: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("tasks"), done: Schema.Number, total: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("table"), rows: Schema.Number, columns: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("code") }),
  Schema.Struct({ kind: Schema.Literal("chart") }),
  Schema.Struct({ kind: Schema.Literal("diagram") }),
  Schema.Struct({ kind: Schema.Literal("callout"), tone: Schema.Literals(CALLOUT_TONES) }),
])
export type OutlineBlock = typeof OutlineBlock.Type

export const DocumentOutline = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  lede: Schema.NullOr(Schema.String),
  blocks: Schema.Array(OutlineBlock),
})
export type DocumentOutline = typeof DocumentOutline.Type

export const OUTLINE_MAX_BLOCKS = 40
const LEDE_LENGTH = 240
export const OUTLINE_HEADING_LENGTH = 120
const SCANNED_INLINE_LENGTH = 2048

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ALERT = /^\[!(note|tip|important|warning|caution)\]$/i
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const TASK = /^\[([ xX])\](?:\s|$)/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const INDENTED = /^(?: {2,}|\t)/

type Lines = ReadonlyArray<string>

type Read = {
  readonly block: OutlineBlock | null
  readonly prose: string | null
  readonly next: number
}

const isBlank = (line: string) => line.trim() === ""

const plainText = (inline: string) =>
  inline
    .slice(0, SCANNED_INLINE_LENGTH)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/(`+)(.+?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

export const shortenText = (text: string, length: number) => {
  const characters = [...text]
  if (characters.length <= length) return text
  const cut = characters.slice(0, length).join("")
  const space = cut.lastIndexOf(" ")
  const words = space > length * 0.6 ? cut.slice(0, space) : cut
  return `${words.replace(/[\s,;:、，。]+$/, "")}…`
}

const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || THEMATIC_BREAK.test(line)

const cellCount = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length

const isTableStart = (lines: Lines, start: number) => {
  const delimiter = lines[start + 1] ?? ""
  return (lines[start] ?? "").includes("|") && delimiter.includes("|") && TABLE_DELIMITER.test(delimiter)
}

const headingBlock = (level: number, text: string): OutlineBlock =>
  level === 1 || level === 2 || level === 3
    ? { kind: "heading", level, text: shortenText(plainText(text), OUTLINE_HEADING_LENGTH) }
    : { kind: "text", length: plainText(text).length }

const fenceKind = (language: string): OutlineBlock => {
  switch (language.toLowerCase()) {
    case "chart":
      return { kind: "chart" }
    case "mermaid":
      return { kind: "diagram" }
    default:
      return { kind: "code" }
  }
}

const readFence = (lines: Lines, start: number, marker: string, language: string): Read => {
  const character = marker[0] ?? "`"
  const closes = (line: string) => {
    const trimmed = line.trim()
    return trimmed.length >= marker.length && trimmed === character.repeat(trimmed.length)
  }
  const end = lines.findIndex((line, index) => index > start && closes(line))
  return { block: fenceKind(language), prose: null, next: end === -1 ? lines.length : end + 1 }
}

const readQuote = (lines: Lines, start: number): Read => {
  const content: Array<string> = []
  let next = start
  for (; next < lines.length; next++) {
    const quoted = QUOTE.exec(lines[next] ?? "")
    if (quoted === null) break
    content.push(quoted[1] ?? "")
  }
  const alert = ALERT.exec((content[0] ?? "").trim())
  if (alert === null) return { block: { kind: "text", length: plainText(content.join(" ")).length }, prose: null, next }
  const body = plainText(content.slice(1).join(" "))
  const tone = calloutTone(alert[1]?.toLowerCase())
  return { block: { kind: "callout", tone }, prose: body === "" ? null : body, next }
}

const readList = (lines: Lines, start: number): Read => {
  let items = 0
  let total = 0
  let done = 0
  let next = start
  for (; next < lines.length; next++) {
    const line = lines[next] ?? ""
    if (isBlank(line)) {
      const following = lines[next + 1] ?? ""
      if (LIST_ITEM.test(following) || INDENTED.test(following)) continue
      break
    }
    const item = THEMATIC_BREAK.test(line) ? null : LIST_ITEM.exec(line)
    if (item !== null) {
      items++
      const task = TASK.exec(item[1] ?? "")
      if (task !== null) {
        total++
        if (task[1] !== " ") done++
      }
      continue
    }
    if (!INDENTED.test(line) && startsBlock(line)) break
  }
  return { block: total > 0 ? { kind: "tasks", done, total } : { kind: "list", items }, prose: null, next }
}

const readTable = (lines: Lines, start: number): Read => {
  const columns = cellCount(lines[start] ?? "")
  let next = start + 2
  while (next < lines.length && !isBlank(lines[next] ?? "") && (lines[next] ?? "").includes("|")) next++
  return { block: { kind: "table", rows: next - start - 2, columns }, prose: null, next }
}

const readParagraph = (lines: Lines, start: number): Read => {
  const content = [lines[start] ?? ""]
  let next = start + 1
  for (; next < lines.length; next++) {
    const line = lines[next] ?? ""
    if (isBlank(line)) break
    const underline = SETEXT_UNDERLINE.exec(line)
    if (underline !== null) {
      const level = underline[1]?.startsWith("=") ? 1 : 2
      return { block: headingBlock(level, content.join(" ")), prose: null, next: next + 1 }
    }
    if (startsBlock(line)) break
    content.push(line)
  }
  const text = plainText(content.join(" "))
  return { block: { kind: "text", length: text.length }, prose: text === "" ? null : text, next }
}

const readBlock = (lines: Lines, start: number): Read => {
  const line = lines[start] ?? ""
  if (isBlank(line) || THEMATIC_BREAK.test(line)) return { block: null, prose: null, next: start + 1 }
  const fence = FENCE.exec(line)
  if (fence !== null) return readFence(lines, start, fence[1] ?? "```", fence[2] ?? "")
  const heading = HEADING.exec(line)
  if (heading !== null)
    return { block: headingBlock(heading[1]?.length ?? 1, heading[2] ?? ""), prose: null, next: start + 1 }
  if (QUOTE.test(line)) return readQuote(lines, start)
  if (LIST_ITEM.test(line)) return readList(lines, start)
  if (isTableStart(lines, start)) return readTable(lines, start)
  return readParagraph(lines, start)
}

export const documentOutline = (markdown: string): DocumentOutline => {
  const lines = markdown.split(/\r?\n/)
  const blocks: Array<OutlineBlock> = []
  let title: string | null = null
  let lede: string | null = null
  let index = 0
  while (index < lines.length && blocks.length < OUTLINE_MAX_BLOCKS) {
    const { block, prose, next } = readBlock(lines, index)
    index = next
    if (block === null) continue
    blocks.push(block)
    if (title === null && block.kind === "heading" && block.level === 1 && block.text !== "") title = block.text
    if (lede === null && prose !== null) lede = shortenText(prose, LEDE_LENGTH)
  }
  return { title, lede, blocks }
}
