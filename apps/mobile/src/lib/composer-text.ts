import type { Decoration } from "@hinacode/composer-editor"
import type { AgentCommand } from "@shared/agent.ts"
import { highlight, type KnownTokens, leadingSkill, segmentText, type SyntaxKind } from "@shared/composerSyntax.ts"

export interface ComposerSpan {
  readonly kind: SyntaxKind | "skill"
  readonly text: string
}

export function composerSpans(
  text: string,
  commands: readonly AgentCommand[],
  known: KnownTokens,
): readonly ComposerSpan[] {
  const skill = leadingSkill(text, commands)
  const token = skill?.token ?? ""
  const rest = highlight(text.slice(token.length), known).map((segment) =>
    segment.kind === "fence" ? { kind: "code" as const, text: segmentText(segment) } : segment,
  )
  return skill ? [{ kind: "skill", text: token.slice(0, -1) }, { kind: "text", text: " " }, ...rest] : rest
}

export function keepSkillWhole(before: string, after: string, commands: readonly AgentCommand[]) {
  const skill = leadingSkill(before, commands)
  if (skill === null || after.startsWith(skill.token) || after.length >= before.length) return after
  let start = 0
  while (start < after.length && before[start] === after[start]) start++
  const end = start + before.length - after.length
  const isDeletion = before.slice(end) === after.slice(start)
  return isDeletion ? before.slice(Math.max(end, skill.token.length)) : after
}

export function composerDecorations(
  text: string,
  commands: readonly AgentCommand[],
  known: KnownTokens,
): readonly Decoration[] {
  const builtin = new Set(commands.filter((command) => command.builtin === true).map((c) => c.trigger + c.name))
  const decorations: Decoration[] = []
  let start = 0
  for (const span of composerSpans(text, commands, known)) {
    const end = start + span.text.length
    switch (span.kind) {
      case "skill":
      case "command":
        decorations.push({ kind: "chip", start, end, icon: builtin.has(span.text) ? "slash" : "skill" })
        break
      case "mention":
        decorations.push({ kind: "token", start, end })
        break
      case "code":
        decorations.push({ kind: "code", start, end })
        break
      case "bullet":
      case "rule":
        decorations.push({ kind: "muted", start, end })
        break
      case "strong":
        decorations.push(
          { kind: "muted", start, end: start + 2 },
          { kind: "strong", start: start + 2, end: end - 2 },
          { kind: "muted", start: end - 2, end },
        )
        break
      case "text":
        decorations.push(...inlineDecorations(span.text, start))
        break
    }
    start = end
  }
  return decorations
}

const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]*)\)/g
const BARE_URL = /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g
const EMPHASIS = /(?<![\w*])\*(?=[^\s*])[^*\n]*?[^\s*]?\*(?![\w*])/g

function inlineDecorations(text: string, offset: number): Decoration[] {
  const decorations: Decoration[] = []
  const taken: [number, number][] = []
  const free = (start: number, end: number) => taken.every(([from, to]) => end <= from || start >= to)
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const start = offset + match.index
    const labelEnd = start + 1 + match[1]!.length
    const end = start + match[0].length
    taken.push([match.index, match.index + match[0].length])
    decorations.push(
      { kind: "muted", start, end: start + 1 },
      { kind: "link", start: start + 1, end: labelEnd },
      { kind: "muted", start: labelEnd, end },
    )
  }
  for (const match of text.matchAll(BARE_URL)) {
    if (!free(match.index, match.index + match[0].length)) continue
    taken.push([match.index, match.index + match[0].length])
    decorations.push({ kind: "link", start: offset + match.index, end: offset + match.index + match[0].length })
  }
  for (const match of text.matchAll(EMPHASIS)) {
    if (match[0].length < 3 || !free(match.index, match.index + match[0].length)) continue
    const start = offset + match.index
    const end = start + match[0].length
    decorations.push(
      { kind: "muted", start, end: start + 1 },
      { kind: "emphasis", start: start + 1, end: end - 1 },
      { kind: "muted", start: end - 1, end },
    )
  }
  return decorations.sort((a, b) => a.start - b.start)
}

export type TextFormat = "strong" | "emphasis" | "link"

const MARKERS: Record<Exclude<TextFormat, "link">, string> = { strong: "**", emphasis: "*" }

export function formatSelection(
  text: string,
  selection: { readonly start: number; readonly end: number },
  format: TextFormat,
): { readonly text: string; readonly selection: { readonly start: number; readonly end: number } } {
  const { start, end } = selection
  const selected = text.slice(start, end)
  if (format === "link") {
    const inserted = `[${selected}]()`
    const caret = start + inserted.length - 1
    return { text: text.slice(0, start) + inserted + text.slice(end), selection: { start: caret, end: caret } }
  }
  const marker = MARKERS[format]
  const wrapped =
    text.slice(start - marker.length, start) === marker &&
    text.slice(end, end + marker.length) === marker &&
    (format !== "emphasis" || (text[start - 2] !== "*" && text[end + 1] !== "*"))
  if (wrapped) {
    const next = text.slice(0, start - marker.length) + selected + text.slice(end + marker.length)
    return { text: next, selection: { start: start - marker.length, end: end - marker.length } }
  }
  const next = text.slice(0, start) + marker + selected + marker + text.slice(end)
  return { text: next, selection: { start: start + marker.length, end: end + marker.length } }
}
