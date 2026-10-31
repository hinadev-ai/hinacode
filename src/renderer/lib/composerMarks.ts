import type { AgentCommand } from "../../shared/agent.ts"
import { fenceCode, highlight, type KnownTokens, segmentText } from "../../shared/composerSyntax.ts"

export type Mark =
  | { readonly kind: "chip"; readonly from: number; readonly to: number; readonly command: AgentCommand }
  | {
      readonly kind: "bullet" | "dot" | "code" | "strong" | "rule" | "command" | "mention" | "marker"
      readonly from: number
      readonly to: number
    }
  | { readonly kind: "fenceLine"; readonly from: number; readonly first: boolean; readonly last: boolean }
  | { readonly kind: "fenceCode"; readonly from: number; readonly code: string; readonly language: string }

export function composerMarks(
  text: string,
  known: KnownTokens,
  commands: ReadonlyArray<AgentCommand>,
  caret: number | null,
): Array<Mark> {
  const byToken = new Map(commands.map((command) => [command.trigger + command.name, command]))
  const marks: Array<Mark> = []
  let offset = 0
  for (const segment of highlight(text, known)) {
    const from = offset
    const piece = segmentText(segment)
    offset += piece.length
    if (segment.kind === "text") continue
    if (segment.kind === "strong") {
      marks.push({ kind: "strong", from, to: offset }, { kind: "marker", from, to: from + 2 })
      marks.push({ kind: "marker", from: offset - 2, to: offset })
      continue
    }
    if (segment.kind === "rule") {
      const caretOnLine = caret !== null && caret >= from && caret <= offset
      marks.push({ kind: caretOnLine ? "marker" : "rule", from, to: offset })
      continue
    }
    if (segment.kind === "bullet" && /^[-*+]$/.test(piece)) {
      marks.push({ kind: "dot", from, to: offset })
      continue
    }
    if (segment.kind !== "fence") {
      const command = segment.kind === "command" ? byToken.get(piece) : undefined
      const stillTyping = caret === offset && (offset === text.length || text[offset] === "\n")
      if (command && !stillTyping) marks.push({ kind: "chip", from, to: offset, command })
      else marks.push({ kind: segment.kind, from, to: offset })
      continue
    }
    const lines = [segment.open, ...segment.lines, ...(segment.close === null ? [] : [segment.close])]
    let lineStart = from
    lines.forEach((line, index) => {
      marks.push({ kind: "fenceLine", from: lineStart, first: index === 0, last: index === lines.length - 1 })
      const isFenceLine = index === 0 || (segment.close !== null && index === lines.length - 1)
      if (isFenceLine && line !== "") marks.push({ kind: "marker", from: lineStart, to: lineStart + line.length })
      lineStart += line.length + 1
    })
    if (segment.language !== "" && segment.lines.length > 0)
      marks.push({
        kind: "fenceCode",
        from: from + segment.open.length + 1,
        code: fenceCode(segment),
        language: segment.language.toLowerCase(),
      })
  }
  return marks
}
