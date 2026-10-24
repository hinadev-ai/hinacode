import type { AgentCommand } from "@shared/agent.ts"
import { highlight, type KnownTokens, leadingSkill, segmentText, type SyntaxKind } from "@shared/composerSyntax.ts"

export interface ComposerSpan {
  readonly kind: SyntaxKind | "skill"
  readonly text: string
}

/**
 * The desktop composer's highlighting as flat spans, for a TextInput that can only nest `Text`: the skill that starts
 * the message, then `highlight` of the rest with each fenced block as one code span. Joining the spans gives back `text`.
 */
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
  // The space that ends the skill's name stays text, so the tint covers only the name.
  return skill ? [{ kind: "skill", text: token.slice(0, -1) }, { kind: "text", text: " " }, ...rest] : rest
}

/**
 * The text after an edit, with the skill that started `before` removed whole when the edit deleted part of it, as
 * Backspace after the desktop's skill chip does. Other edits come back as they are.
 */
export function keepSkillWhole(before: string, after: string, commands: readonly AgentCommand[]) {
  const skill = leadingSkill(before, commands)
  if (skill === null || after.startsWith(skill.token) || after.length >= before.length) return after
  let start = 0
  while (start < after.length && before[start] === after[start]) start++
  const end = start + before.length - after.length
  const isDeletion = before.slice(end) === after.slice(start)
  return isDeletion ? before.slice(Math.max(end, skill.token.length)) : after
}
