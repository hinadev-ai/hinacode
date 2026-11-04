import { type CalloutTone, splitCalloutMarker } from "@shared/documentCallout.ts"
import { type Chart, formatChartValue, parseChart } from "@shared/documentChart.ts"
import { locale } from "./copy"
import { rewriteMarkdownExtras } from "./markdown-extras"

export type DocumentSegment =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "callout"; readonly tone: CalloutTone; readonly text: string }

const OPENING_FENCE = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/
const QUOTE = /^ {0,3}> ?(.*)$/
const LIST_OR_INDENTED = /^(?:\s+|\s*(?:[-*+]|\d{1,9}[.)])[ \t])/

/** Past this, a segment ends at the next paragraph break, so a long document's list can window it. */
const SEGMENT_CHARACTERS = 8192

const isClosingFence = (line: string, marker: string) => {
  const trimmed = line.trimEnd()
  const indent = trimmed.length - trimmed.trimStart().length
  const run = trimmed.trimStart()
  return indent <= 3 && run.length >= marker.length && run === (marker[0] ?? "`").repeat(run.length)
}

const tableCell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")

function chartAsMarkdown({ spec, labels }: Chart) {
  const header = [spec.x, ...labels].map(tableCell)
  const rows = spec.rows.map((row) => [
    tableCell(String(row[spec.x] ?? "")),
    ...spec.series.map(({ key }) => {
      const value = row[key]
      return typeof value === "number" ? tableCell(formatChartValue(spec, value, locale)) : ""
    }),
  ])
  const table = [header, header.map((_, column) => (column === 0 ? "---" : "---:")), ...rows]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n")
  return [spec.title && `**${spec.title}**`, spec.notes, table].filter(Boolean).join("\n\n")
}

/**
 * Splits a document into runs of Markdown and the callouts between them, since a callout draws as its own view. A
 * valid chart fence becomes its title, notes and a table of its rows. Fenced code stays as written, an invalid chart
 * and a mermaid diagram included, and a quote is a callout only when its first line holds nothing but the marker.
 */
export function documentSegments(markdown: string): readonly DocumentSegment[] {
  const lines = rewriteMarkdownExtras(markdown).split(/\r?\n/)
  const segments: DocumentSegment[] = []
  let prose: string[] = []
  let proseCharacters = 0

  const add = (text: string) => {
    prose.push(text)
    proseCharacters += text.length + 1
  }
  const endProse = () => {
    const text = prose.join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd()
    if (text !== "") segments.push({ kind: "markdown", text })
    prose = []
    proseCharacters = 0
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const fence = OPENING_FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? fence[3] ?? ""
      const language = (fence[2] ?? fence[4] ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase()
      let end = index + 1
      while (end < lines.length && !isClosingFence(lines[end] ?? "", marker)) end++
      const parsed = language === "chart" ? parseChart(lines.slice(index + 1, end).join("\n")) : null
      if (parsed?.ok === true) add(chartAsMarkdown(parsed.chart))
      else add(lines.slice(index, end + 1).join("\n"))
      index = end
      continue
    }
    if (QUOTE.test(line)) {
      let end = index
      while (end + 1 < lines.length && QUOTE.test(lines[end + 1] ?? "")) end++
      const quote = lines.slice(index, end + 1)
      const callout = splitCalloutMarker(quote.map((quoted) => QUOTE.exec(quoted)?.[1] ?? "").join("\n"))
      if (callout === null) add(quote.join("\n"))
      else {
        endProse()
        segments.push({ kind: "callout", tone: callout.tone, text: callout.rest.trim() })
      }
      index = end
      continue
    }
    if (line.trim() === "" && proseCharacters >= SEGMENT_CHARACTERS && !LIST_OR_INDENTED.test(lines[index + 1] ?? ""))
      endProse()
    else add(line)
  }
  endProse()
  return segments
}
