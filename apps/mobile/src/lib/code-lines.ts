import type { SyntaxClass, SyntaxSpan } from "@/lib/highlight"

export interface LineSpan {
  readonly type: SyntaxClass
  readonly text: string
}

export type CodeLine = readonly LineSpan[]

/**
 * Splits `source` into lines of colored text. Spans may cross line breaks, and text no span covers, such as
 * the part after a highlighted prefix, is plain. `\r\n` ends a line like `\n`, and a final line break does not
 * start an empty last line. Pass null spans to get plain lines.
 */
export function codeLines(source: string, spans: readonly SyntaxSpan[] | null): CodeLine[] {
  const lines: LineSpan[][] = [[]]
  const push = (type: SyntaxClass, start: number, end: number) => {
    const parts = source.slice(start, end).split("\n")
    parts.forEach((text, index) => {
      if (index > 0) lines.push([])
      if (text !== "") lines[lines.length - 1].push({ type, text })
    })
  }

  let at = 0
  for (const span of spans ?? []) {
    const start = Math.max(span.start, at)
    const end = Math.min(span.end, source.length)
    if (end <= start) continue
    if (start > at) push("plain", at, start)
    push(span.type, start, end)
    at = end
  }
  if (at < source.length) push("plain", at, source.length)

  if (lines.length > 1 && source.endsWith("\n")) lines.pop()
  return lines.map(withoutCarriageReturn)
}

function withoutCarriageReturn(line: LineSpan[]): CodeLine {
  const last = line[line.length - 1]
  if (last === undefined || !last.text.endsWith("\r")) return line
  const text = last.text.slice(0, -1)
  return text === "" ? line.slice(0, -1) : [...line.slice(0, -1), { type: last.type, text }]
}
