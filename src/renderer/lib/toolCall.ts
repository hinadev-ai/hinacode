import type { AgentCommand } from "../../shared/agent.ts"
import { type MessagePart, createsThread, publishesArtifact, spawnsSubagent } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"]

function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  for (const key of SUMMARY_KEYS) {
    const value: unknown = Reflect.get(input, key)
    if (typeof value === "string") return value
  }
  return JSON.stringify(input)
}

export function describeToolCall(part: Extract<MessagePart, { type: "tool_call" }>): {
  name: string
  summary: string
} {
  const { input } = part
  if (typeof input === "object" && input !== null && Reflect.get(input, "type") === "mcpToolCall") {
    return {
      name: `${String(Reflect.get(input, "server"))}/${String(Reflect.get(input, "tool"))}`,
      summary: summarizeInput(Reflect.get(input, "arguments")),
    }
  }
  const summary = summarizeInput(input)
  return { name: part.name, summary: part.name === "Bash" ? unwrapShell(summary) : summary }
}

// FIXME: Codex wraps every command in a login shell, such as /bin/zsh -lc '<command>'
const SHELL_WRAPPER = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/s

const unwrapShell = (command: string) => {
  const inner = SHELL_WRAPPER.exec(command)?.[1]
  return inner === undefined ? command : inner.replaceAll(`'\\''`, "'")
}

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export type ActivityPart = ToolCall | Extract<MessagePart, { type: "reasoning" }>

export type TranscriptBlock =
  | { readonly type: "part"; readonly part: MessagePart; readonly index: number }
  | { readonly type: "tools"; readonly parts: ReadonlyArray<ActivityPart>; readonly index: number }

const isFoldable = (part: MessagePart): part is ActivityPart =>
  part.type === "reasoning" ||
  (part.type === "tool_call" && !spawnsSubagent(part) && !publishesArtifact(part) && !createsThread(part))

export function groupToolCalls(parts: ReadonlyArray<MessagePart>, startIndex = 0): Array<TranscriptBlock> {
  const blocks: Array<TranscriptBlock> = []
  let run: Array<ActivityPart> = []
  const endRun = (end: number) => {
    const start = end - run.length
    if (run.length > 1 && run.some((part) => part.type === "tool_call")) {
      blocks.push({ type: "tools", parts: run, index: start })
    } else {
      blocks.push(...run.map((part, position) => ({ type: "part" as const, part, index: start + position })))
    }
    run = []
  }
  for (const [position, part] of parts.entries()) {
    const index = startIndex + position
    if (isFoldable(part)) {
      run.push(part)
      continue
    }
    endRun(index)
    blocks.push({ type: "part", part, index })
  }
  endRun(startIndex + parts.length)
  return blocks
}

const SKILL_FILE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/
const READ_PROGRAMS = new Set(["cat", "head", "nl"])

const skillFromFile = (path: string) => SKILL_FILE.exec(path.replace(/^['"]|['"]$/g, ""))?.[1]

function skillsReadBy(command: string): Array<string> | null {
  const [program, ...rest] = command.trim().split(/\s+/)
  const paths = program === "sed" && rest[0] === "-n" ? rest.slice(2) : READ_PROGRAMS.has(program ?? "") ? rest : []
  const skills = paths.map(skillFromFile)
  return skills.length > 0 && skills.every((skill) => skill !== undefined) ? skills : null
}

const textField = (input: unknown, key: string) => {
  const value: unknown = typeof input === "object" && input !== null ? Reflect.get(input, key) : undefined
  return typeof value === "string" && value !== "" ? value : undefined
}

export function skillsUsed(call: ToolCall): Array<string> | null {
  const named =
    call.name === "Skill"
      ? textField(call.input, "skill")
      : call.name === "read_skill"
        ? textField(call.input, "name")
        : undefined
  if (named !== undefined) return [named]
  return call.name === "Bash" ? skillsReadBy(describeToolCall(call).summary) : null
}

export type SkillLabels = ReadonlyMap<string, string>

export const skillLabelsOf = (commands: ReadonlyArray<AgentCommand>): SkillLabels =>
  new Map(commands.map((command) => [command.name, command.label ?? command.name]))

const conjunctionFormats = new Map<string, Intl.ListFormat>()

export function conjunctionFormat(locale: string) {
  const cached = conjunctionFormats.get(locale)
  if (cached) return cached
  const format = new Intl.ListFormat(locale, { type: "conjunction" })
  conjunctionFormats.set(locale, format)
  return format
}

export function skillUseText(skills: ReadonlyArray<string>, labels: SkillLabels): string {
  const names = skills.map((skill) => `"${labels.get(skill) ?? skill.slice(skill.indexOf(":") + 1)}"`)
  return m.tool_skill_used({ count: skills.length, skills: conjunctionFormat(getLocale()).format(names) })
}

export type ToolKind = "command" | "read" | "edit" | "search" | "skill" | "other"

const toolKinds: Record<string, ToolKind> = {
  Bash: "command",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Glob: "search",
  Grep: "search",
}

export function countToolKinds(calls: ReadonlyArray<ToolCall>): Array<{ kind: ToolKind; count: number }> {
  const counts = new Map<ToolKind, number>(
    (["command", "read", "edit", "search", "skill", "other"] as const).map((kind) => [kind, 0]),
  )
  for (const call of calls) {
    const skills = skillsUsed(call)
    const kind = skills === null ? (toolKinds[call.name] ?? "other") : "skill"
    counts.set(kind, (counts.get(kind) ?? 0) + (skills?.length ?? 1))
  }
  return [...counts].flatMap(([kind, count]) => (count > 0 ? [{ kind, count }] : []))
}

export function describeCommand(call: ToolCall): string {
  const description: unknown =
    typeof call.input === "object" && call.input !== null ? Reflect.get(call.input, "description") : undefined
  return typeof description === "string" && description !== "" ? description : describeToolCall(call).summary
}
