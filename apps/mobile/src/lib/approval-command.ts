import type { ApprovalRequest } from "@shared/agent.ts"

/**
 * The shell command a command approval would run, and the agent's note about it. Claude puts its description in
 * `detail` and the command in the session scope, while ACP agents put the command itself in `detail`.
 */
export function approvalCommand(request: ApprovalRequest): { readonly command: string; readonly note: string } {
  const scoped = request.sessionScope?.kind === "command" ? request.sessionScope.value : ""
  const input = request.input
  const typed =
    typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
      ? input.command
      : ""
  const command = scoped || typed || request.detail || request.title
  return { command, note: request.detail === command ? "" : request.detail }
}
