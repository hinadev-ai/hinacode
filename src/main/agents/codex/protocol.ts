import { Schema } from "effect"

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
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: "restricted" | "enabled" }
  | {
      type: "workspaceWrite"
      writableRoots: Array<string>
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

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
/** `sandbox` is the policy in effect, including the user's config. */
export type ThreadStartResponse = { thread: Thread; sandbox: SandboxPolicy }
export type ThreadResumeResponse = ThreadStartResponse

export type UserInput =
  | { type: "text"; text: string; text_elements: Array<unknown> }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }

export type TurnStartParams = {
  threadId: string
  input: Array<UserInput>
  cwd?: string | null
  model?: string | null
  /** Omitted keeps the thread's effort. */
  effort?: string | null
  /** Omitted keeps the thread's tier; null goes back to the standard one. */
  serviceTier?: string | null
  /** Applies to this turn and the ones after it. */
  approvalPolicy?: AskForApproval | null
  sandboxPolicy?: SandboxPolicy | null
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

export type SkillsListParams = { cwds?: Array<string>; forceReload?: boolean }
export type SkillMetadata = {
  name: string
  description: string
  shortDescription?: string
  path: string
  enabled: boolean
}
export type SkillsListResponse = { data: Array<{ cwd: string; skills: Array<SkillMetadata> }> }

export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined"
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined"
export type McpToolCallStatus = "inProgress" | "completed" | "failed"

export type PatchChangeKind = { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null }
export type FileUpdateChange = { path: string; kind: PatchChangeKind; diff: string }

export type CollabAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent"
  | "sendMessage"
  | "followupTask"
  | "interruptAgent"
  | "listAgents"
export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed" | "interrupted"
export type CollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound"
export type CollabAgentState = { status: CollabAgentStatus; message: string | null }
export type SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed"

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
  | {
      type: "collabAgentToolCall"
      id: string
      tool: CollabAgentTool
      status: CollabAgentToolCallStatus
      senderThreadId: string
      /** For spawnAgent, the newly spawned agent's thread. */
      receiverThreadIds: Array<string>
      prompt: string | null
      model: string | null
      agentsStates: { [key in string]?: CollabAgentState }
    }
  | {
      type: "subAgentActivity"
      id: string
      kind: SubAgentActivityKind
      agentThreadId: string
      agentPath: string
      model: string | null
    }
  | {
      type: "agentMessage"
      id: string
      text: string
      /** Set by `request_user_input_async`: the user answers with their next message, and the item has no deltas. */
      questions?: Array<AsyncUserInputQuestion> | null
    }
  | { type: "reasoning" | "userMessage" | "plan" | "webSearch"; id: string }

export type AsyncUserInputQuestion = { title: string; options: Array<string> | null }

export type TokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}
export type ThreadTokenUsage = {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

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
  "item/tool/requestUserInput": ToolRequestUserInputParams
}

/** EXPERIMENTAL in Codex. `isOther` lets the user type an answer; `options` is null for a free-text question. */
export type ToolRequestUserInputQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}
export type ToolRequestUserInputParams = {
  threadId: string
  turnId: string
  itemId: string
  questions: Array<ToolRequestUserInputQuestion>
}
/** Answers keyed by question id. */
export type ToolRequestUserInputResponse = { answers: { [id in string]?: { answers: Array<string> } } }

/** Codex asks before every MCP tool call through an elicitation tagged `codex_approval_kind: "mcp_tool_call"`. */
export interface McpServerElicitationRequestParams {
  threadId: string
  turnId: string | null
  serverName: string
  message: string
  _meta: { codex_approval_kind?: string; [key: string]: unknown } | null
}

export type ElicitationActionWire = "accept" | "decline" | "cancel"

export type GetAccountParams = { refreshToken?: boolean }
export const PlanType = Schema.Literals([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "promax",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
])
export type PlanType = typeof PlanType.Type
export const Account = Schema.Union([
  Schema.Struct({ type: Schema.Literal("apiKey") }),
  Schema.Struct({ type: Schema.Literal("chatgpt"), email: Schema.NullOr(Schema.String), planType: PlanType }),
  Schema.Struct({ type: Schema.Literal("amazonBedrock"), usesCodexManagedCredentials: Schema.Boolean }),
])
export type Account = typeof Account.Type
export const GetAccountResponse = Schema.Struct({ account: Schema.NullOr(Account), requiresOpenaiAuth: Schema.Boolean })
export type GetAccountResponse = typeof GetAccountResponse.Type
