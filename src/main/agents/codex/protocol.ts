/**
 * Subset of the Codex app-server v2 protocol used by kkcode.
 * Copied from `codex app-server generate-ts` (codex-cli 0.161.0), trimmed to the fields we read or send.
 * Regenerate with that command when bumping Codex and re-copy the shapes below.
 */

export type RequestId = string | number

export type InitializeParams = {
  clientInfo: { name: string; title: string | null; version: string }
  capabilities: { experimentalApi: boolean; optOutNotificationMethods?: Array<string> | null } | null
}

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type AskForApproval = "untrusted" | "on-request" | "never"

export type ThreadStartParams = {
  model?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  config?: { [key in string]?: unknown } | null
}

export type ThreadResumeParams = ThreadStartParams & {
  threadId: string
  excludeTurns?: boolean
}

export type Thread = { id: string; sessionId: string }
export type ThreadStartResponse = { thread: Thread }
export type ThreadResumeResponse = { thread: Thread }

export type UserInput =
  | { type: "text"; text: string; text_elements: Array<unknown> }
  | { type: "localImage"; path: string }

export type TurnStartParams = {
  threadId: string
  input: Array<UserInput>
  cwd?: string | null
  model?: string | null
  /** Omitted keeps the thread's effort. */
  effort?: string | null
  /** Omitted keeps the thread's tier; null goes back to the standard one. */
  serviceTier?: string | null
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"
export type TurnError = { message: string; additionalDetails: string | null }
export type Turn = { id: string; status: TurnStatus; error: TurnError | null }
export type TurnStartResponse = { turn: Turn }
export type TurnInterruptParams = { threadId: string; turnId: string }
/** Fails unless `expectedTurnId` is the thread's active turn. */
export type TurnSteerParams = { threadId: string; input: Array<UserInput>; expectedTurnId: string }

export type ModelListParams = { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null }
export type Model = {
  id: string
  model: string
  displayName: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  defaultReasoningEffort: string
  serviceTiers: Array<{ id: string; name: string; description: string }>
}
export type ModelListResponse = { data: Array<Model>; nextCursor: string | null }

export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined"
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined"
export type McpToolCallStatus = "inProgress" | "completed" | "failed"

export type PatchChangeKind = { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null }
export type FileUpdateChange = { path: string; kind: PatchChangeKind; diff: string }

export type ThreadItem =
  | {
      type: "commandExecution"
      id: string
      command: string
      cwd: string
      status: CommandExecutionStatus
      aggregatedOutput: string | null
      exitCode: number | null
    }
  | { type: "fileChange"; id: string; changes: Array<FileUpdateChange>; status: PatchApplyStatus }
  | {
      type: "mcpToolCall"
      id: string
      server: string
      tool: string
      status: McpToolCallStatus
      arguments: unknown
      result: { content: Array<unknown>; structuredContent: unknown } | null
      error: { message: string } | null
    }
  | { type: "agentMessage" | "reasoning" | "userMessage" | "plan" | "webSearch"; id: string }

export type TokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}
export type ThreadTokenUsage = { total: TokenUsageBreakdown; last: TokenUsageBreakdown }

/** Params of the server notifications kkcode handles, keyed by method. */
export type ServerNotificationParams = {
  "item/agentMessage/delta": { threadId: string; turnId: string; itemId: string; delta: string }
  "item/reasoning/summaryTextDelta": { threadId: string; turnId: string; itemId: string; delta: string }
  "item/reasoning/textDelta": { threadId: string; turnId: string; itemId: string; delta: string }
  "item/commandExecution/outputDelta": { threadId: string; turnId: string; itemId: string; delta: string }
  "item/started": { threadId: string; turnId: string; item: ThreadItem }
  "item/completed": { threadId: string; turnId: string; item: ThreadItem }
  "thread/tokenUsage/updated": { threadId: string; turnId: string; tokenUsage: ThreadTokenUsage }
  "turn/completed": { threadId: string; turn: Turn }
  error: { error: TurnError; willRetry: boolean; threadId: string; turnId: string }
}

export type CommandExecutionRequestApprovalParams = {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  command?: string | null
  cwd?: string | null
}
export type FileChangeRequestApprovalParams = {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}

/** Shared by CommandExecutionApprovalDecision and FileChangeApprovalDecision for the variants kkcode sends. */
export type ApprovalDecisionWire = "accept" | "acceptForSession" | "decline" | "cancel"

export type ServerRequestParams = {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalParams
  "item/fileChange/requestApproval": FileChangeRequestApprovalParams
  "mcpServer/elicitation/request": McpServerElicitationRequestParams
}

/** Codex asks before every MCP tool call through an elicitation tagged `codex_approval_kind: "mcp_tool_call"`. */
export interface McpServerElicitationRequestParams {
  threadId: string
  turnId: string | null
  serverName: string
  message: string
  _meta: { codex_approval_kind?: string; [key: string]: unknown } | null
}

export type ElicitationActionWire = "accept" | "decline" | "cancel"
