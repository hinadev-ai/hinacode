import { Option, Predicate, Schema } from "effect"
import type { ApprovalDecision, ApprovalKind, ApprovalRequest, ProviderId } from "../../../shared/agent.ts"
import type { AccessMode } from "../../../shared/domain.ts"
import type { PermissionOption, RequestPermissionParams } from "./protocol.ts"
import { toolCommand, toolPath, type ToolState } from "./updates.ts"

const autoAllowedKinds = new Set(["read", "search", "fetch", "think", "edit"])

export const autoAllows = (mode: AccessMode, kind: string | null) =>
  mode === "full" || (mode === "auto" && autoAllowedKinds.has(kind ?? ""))

const optionOrder: Record<ApprovalDecision, ReadonlyArray<string>> = {
  allow: ["allow_once", "allow_always"],
  allow_for_session: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
}

export const optionFor = (
  decision: ApprovalDecision,
  options: ReadonlyArray<PermissionOption>,
): PermissionOption | undefined =>
  optionOrder[decision]
    .map((kind) => options.find((option) => option.kind === kind))
    .find((option) => option !== undefined)

export const permissionOutcome = (option: PermissionOption | undefined) => ({
  outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId },
})

const DiffContent = Schema.Struct({
  type: Schema.Literal("diff"),
  path: Schema.String,
  oldText: Schema.optional(Schema.NullOr(Schema.String)),
  newText: Schema.String,
})
const decodeDiffContent = Schema.decodeUnknownOption(DiffContent)

const changeSummary = (params: RequestPermissionParams): string | undefined => {
  const diff = Predicate.isObject(params.toolCall.rawInput) ? params.toolCall.rawInput["diff"] : undefined
  if (typeof diff === "string" && diff !== "") return diff
  const blocks = (params.toolCall.content ?? []).flatMap((block) => Option.toArray(decodeDiffContent(block)))
  if (blocks.length === 0) return undefined
  return blocks.map((block) => `${block.path}\n${block.newText}`).join("\n\n")
}

const describe = (
  tool: ToolState,
  params: RequestPermissionParams,
): { kind: ApprovalKind; title: string; detail: string } => {
  const path = toolPath(tool) ?? params.toolCall.locations?.[0]?.path ?? ""
  switch (tool.kind) {
    case "execute":
      return { kind: "command", title: "Run command", detail: toolCommand(tool) }
    case "edit":
      return { kind: "patch", title: "Edit file", detail: changeSummary(params) ?? path }
    case "delete":
      return { kind: "patch", title: "Delete file", detail: path }
    case "move":
      return { kind: "patch", title: "Move file", detail: path }
    case "read":
      return { kind: "tool", title: "Read file", detail: path }
    default:
      return { kind: "tool", title: tool.title === "" ? "Use a tool" : tool.title, detail: path }
  }
}

export const mergePermissionTool = (known: ToolState | undefined, params: RequestPermissionParams): ToolState => {
  const { toolCall } = params
  const hasInput = Predicate.isObject(toolCall.rawInput) && Object.keys(toolCall.rawInput).length > 0
  return {
    id: toolCall.toolCallId,
    kind: toolCall.kind ?? known?.kind ?? null,
    title: known?.title || (toolCall.title ?? ""),
    status: "pending",
    locations: known?.locations.length ? known.locations : (toolCall.locations ?? []).map((l) => l.path),
    content: toolCall.content ?? known?.content ?? [],
    rawInput: known?.rawInput ?? (hasInput ? toolCall.rawInput : undefined),
    rawOutput: undefined,
    started: false,
  }
}

export const toApprovalRequest = (input: {
  readonly id: string
  readonly threadId: string
  readonly provider: ProviderId
  readonly tool: ToolState
  readonly params: RequestPermissionParams
}): ApprovalRequest => ({
  id: input.id,
  threadId: input.threadId,
  provider: input.provider,
  ...describe(input.tool, input.params),
  input: input.tool.rawInput ?? input.params.toolCall.rawInput,
})
