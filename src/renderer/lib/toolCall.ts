import { Schema } from "effect"
import type { AgentCommand } from "../../shared/agent.ts"
import { Attachment, type MessagePart, createsThread, publishesArtifact, spawnsSubagent } from "../../shared/domain.ts"
import { type Todo, todosInCall } from "../../shared/todos.ts"
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

const ownToolLabels = new Map<string, () => string>([
  ["create_thread", m.tool_own_create_thread],
  ["list_machines", m.tool_own_list_machines],
  ["list_threads", m.tool_own_list_threads],
  ["search_threads", m.tool_own_search_threads],
  ["read_thread", m.tool_own_read_thread],
  ["send_to_thread", m.tool_own_send_to_thread],
  ["stop_thread", m.tool_own_stop_thread],
  ["list_terminals", m.tool_own_list_terminals],
  ["read_terminal", m.tool_own_read_terminal],
  ["link_pull_request", m.tool_own_link_pull_request],
  ["list_thread_pull_requests", m.tool_own_list_thread_pull_requests],
  ["unlink_pull_request", m.tool_own_unlink_pull_request],
  ["watch_pull_request", m.tool_own_watch_pull_request],
  ["unwatch_pull_request", m.tool_own_unwatch_pull_request],
  ["review_changes", m.tool_own_review_changes],
  ["request_secret", m.tool_own_request_secret],
  ["linear_get_issue", m.tool_own_linear_get_issue],
  ["linear_search_issues", m.tool_own_linear_search_issues],
  ["linear_create_comment", m.tool_own_linear_create_comment],
  ["linear_update_issue_state", m.tool_own_linear_update_issue_state],
  ["publish_artifact", m.tool_own_publish_artifact],
  ["publish_document", m.tool_own_publish_document],
  ["publish_whiteboard", m.tool_own_publish_whiteboard],
  ["request_verification", m.tool_own_request_verification],
  ["comment_on_artifact", m.tool_own_comment_on_artifact],
  ["document_chart_guide", m.tool_own_document_chart_guide],
  ["list_artifacts", m.tool_own_list_artifacts],
  ["read_artifact", m.tool_own_read_artifact],
  ["run_agent", m.tool_own_run_agent],
  ["wait_agent", m.tool_own_wait_agent],
  ["vm_screenshot", m.tool_own_vm_screenshot],
  ["vm_click", m.tool_own_vm_click],
  ["vm_move", m.tool_own_vm_move],
  ["vm_drag", m.tool_own_vm_drag],
  ["vm_scroll", m.tool_own_vm_scroll],
  ["vm_type", m.tool_own_vm_type],
  ["vm_key", m.tool_own_vm_key],
  ["vm_exec", m.tool_own_vm_exec],
  ["vm_stop", m.tool_own_vm_stop],
  ["vm_pull_file", m.tool_own_vm_pull_file],
  ["device_screenshot", m.tool_own_device_screenshot],
  ["device_tap", m.tool_own_device_tap],
  ["device_swipe", m.tool_own_device_swipe],
  ["device_type", m.tool_own_device_type],
  ["device_button", m.tool_own_device_button],
  ["device_launch", m.tool_own_device_launch],
  ["device_open_url", m.tool_own_device_open_url],
  ["device_describe_ui", m.tool_own_device_describe_ui],
])

const OWN_TOOL_PREFIX = /^(?:mcp__hinacode__|hinacode[_/])/

export const ownToolName = (name: string) => name.replace(OWN_TOOL_PREFIX, "")

const OWN_SUMMARY_KEYS = ["title", "url", "query"]

function summarizeOwnInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  for (const key of OWN_SUMMARY_KEYS) {
    const value: unknown = Reflect.get(input, key)
    if (typeof value === "string") return value
  }
  return Object.values(input).find((value): value is string => typeof value === "string") ?? ""
}

const todoLabels = new Map<string, () => string>([
  ["TodoWrite", m.tool_todos_update],
  ["write_todos", m.tool_todos_update],
  ["update_plan", m.tool_todos_update],
  ["TaskCreate", m.tool_task_add],
  ["TaskUpdate", m.tool_task_update],
])

function summarizeTodos(todos: ReadonlyArray<Todo>): string {
  if (todos.length === 1) return todos[0]?.text ?? ""
  const done = todos.filter((todo) => todo.status === "completed").length
  return m.composer_todos_progress({ done: String(done), total: String(todos.length) })
}

export function describeToolCall(part: { readonly name: string; readonly input: unknown }): {
  name: string
  summary: string
} {
  const { input } = part
  const todoLabel = todoLabels.get(part.name)
  const todos = todoLabel === undefined ? null : todosInCall(part)
  if (todoLabel !== undefined && todos !== null) return { name: todoLabel(), summary: summarizeTodos(todos) }
  if (typeof input === "object" && input !== null && Reflect.get(input, "type") === "mcpToolCall") {
    const server = String(Reflect.get(input, "server"))
    const tool = String(Reflect.get(input, "tool"))
    const args: unknown = Reflect.get(input, "arguments")
    const label = server === "hinacode" ? ownToolLabels.get(tool) : undefined
    return label === undefined
      ? { name: `${server}/${tool}`, summary: summarizeInput(args) }
      : { name: label(), summary: summarizeOwnInput(args) }
  }
  const label = ownToolLabels.get(ownToolName(part.name))
  if (label !== undefined) return { name: label(), summary: summarizeOwnInput(input) }
  const summary = summarizeInput(input)
  return { name: part.name, summary: part.name === "Bash" ? unwrapShell(summary) : summary }
}

const isAttachment = Schema.is(Attachment)

export function toolOutputImages(output: unknown): Array<Attachment> {
  const content =
    typeof output === "object" && output !== null && !Array.isArray(output) ? Reflect.get(output, "content") : output
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    const attachment: unknown = typeof block === "object" && block !== null ? Reflect.get(block, "attachment") : null
    return isAttachment(attachment) ? [attachment] : []
  })
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
