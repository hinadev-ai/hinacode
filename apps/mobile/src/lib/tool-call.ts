import { outputPreview, toolSummary } from "@shared/compactTranscript.ts"
import { ownToolName, unwrapShell } from "@shared/toolNames.ts"
import type { IconName } from "@/components/icon"
import { copy } from "@/lib/copy"

const ownTools = [
  "create_thread",
  "list_machines",
  "list_threads",
  "search_threads",
  "read_thread",
  "send_to_thread",
  "stop_thread",
  "list_terminals",
  "read_terminal",
  "link_pull_request",
  "list_thread_pull_requests",
  "unlink_pull_request",
  "watch_pull_request",
  "unwatch_pull_request",
  "review_changes",
  "request_secret",
  "linear_get_issue",
  "linear_search_issues",
  "linear_create_comment",
  "linear_update_issue_state",
  "publish_artifact",
  "publish_document",
  "document_chart_guide",
  "list_artifacts",
  "read_artifact",
  "run_agent",
  "wait_agent",
  "vm_screenshot",
  "vm_click",
  "vm_move",
  "vm_drag",
  "vm_scroll",
  "vm_type",
  "vm_key",
  "vm_exec",
  "vm_stop",
  "vm_pull_file",
  "device_screenshot",
  "device_tap",
  "device_swipe",
  "device_type",
  "device_button",
  "device_launch",
  "device_open_url",
  "device_describe_ui",
] as const

type OwnTool = (typeof ownTools)[number]

const isOwnTool = (name: string): name is OwnTool => (ownTools as readonly string[]).includes(name)

export function describeToolCall(call: { readonly name: string; readonly input: unknown }) {
  const own = ownToolName(call.name)
  const summary = toolSummary(call.input)?.line ?? ""
  return {
    name: isOwnTool(own) ? copy(`tool_own_${own}`) : call.name,
    summary: call.name === "Bash" ? unwrapShell(summary) : summary,
  }
}

const toolIcons: Record<string, IconName> = {
  Bash: "Terminal",
  Read: "FileText",
  Edit: "Pencil",
  MultiEdit: "Pencil",
  Write: "Pencil",
  NotebookEdit: "Pencil",
  Glob: "Search",
  Grep: "Search",
  WebFetch: "Globe",
  WebSearch: "Globe",
  TodoWrite: "CheckCircle",
  write_todos: "CheckCircle",
  update_plan: "CheckCircle",
  TaskCreate: "CheckCircle",
  TaskUpdate: "CheckCircle",
  link_pull_request: "RiGitPullRequestLine",
  list_thread_pull_requests: "RiGitPullRequestLine",
  unlink_pull_request: "RiGitPullRequestLine",
  watch_pull_request: "RiGitPullRequestLine",
  unwatch_pull_request: "RiGitPullRequestLine",
  publish_artifact: "Layout",
  list_artifacts: "Layout",
  read_artifact: "Layout",
  publish_document: "FileText",
}

export const toolIcon = (name: string): IconName => toolIcons[ownToolName(name)] ?? "Tools"

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

function outputText(output: unknown): string {
  if (output === undefined || output === null) return ""
  if (typeof output === "string") return output
  // FIXME: Codex wraps an MCP tool's result in `{ content: [...] }`
  const content = Array.isArray(output) ? output : field(output, "content")
  if (!Array.isArray(content)) return JSON.stringify(output, null, 2)
  return content
    .map((block: unknown) => {
      if (field(block, "type") === "image") return copy("mobile_chat_tool_output_image")
      const text = field(block, "text")
      return typeof text === "string" ? text : JSON.stringify(block)
    })
    .join("\n")
}

/** The output as plain text, cut to its tail when it is too long to lay out in a transcript row. */
export function shownOutput(output: unknown): { readonly text: string; readonly truncated: boolean } {
  const text = outputText(output).replace(ANSI_ESCAPE, "").replace(/\s+$/, "")
  const preview = outputPreview(text)
  return preview === undefined ? { text, truncated: false } : { text: preview.output, truncated: true }
}
