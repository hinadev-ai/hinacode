import { Predicate } from "effect"
import type { ApprovalDecision, ApprovalKind, ApprovalRequest, SessionScope } from "../../../shared/agent.ts"
import { toolInput, toolName } from "./items.ts"
import type { ApprovalChoice, ApprovalRequestParams } from "./protocol.ts"

const choiceOrder: Record<ApprovalDecision, ReadonlyArray<string>> = {
  allow: ["approved"],
  allow_for_session: ["approvedForSession", "approved"],
  deny: ["denied", "abort"],
}

export const choiceFor = (
  decision: ApprovalDecision,
  choices: ReadonlyArray<ApprovalChoice>,
): ApprovalChoice | undefined =>
  choiceOrder[decision]
    .map((wanted) => choices.find((choice) => choice.decision === wanted))
    .find((choice) => choice !== undefined)

export const sessionScope = ({ subject, toolName: tool }: ApprovalRequestParams): SessionScope => {
  const name = toolName(subject.toolName ?? tool)
  if (subject.kind === "shell" && subject.command !== undefined) {
    return { tool: "Bash", kind: "command", value: subject.command }
  }
  if (subject.kind === "fileAccess" && subject.path !== undefined) {
    return { tool: name, kind: "path", value: subject.path }
  }
  if (subject.kind === "network" && subject.host !== undefined) {
    return { tool: name, kind: "domain", value: subject.host }
  }
  return { tool: name, kind: "tool", value: name }
}

const describe = ({ subject, rawArgs, toolName: tool }: ApprovalRequestParams) => {
  switch (subject.kind) {
    case "shell": {
      const input = toolInput(rawArgs)
      const description = Predicate.isObject(input) ? input.description : undefined
      return {
        kind: "command" as ApprovalKind,
        title: typeof description === "string" && description !== "" ? description : "Run command",
        detail: subject.command ?? rawArgs,
      }
    }
    case "fileAccess":
      return {
        kind: (subject.access === "read" ? "tool" : "patch") as ApprovalKind,
        title: subject.access === "read" ? "Read file" : "Write file",
        detail: subject.path ?? rawArgs,
      }
    case "network":
      return {
        kind: "tool" as ApprovalKind,
        title: "Network access",
        detail: [subject.protocol, subject.host, subject.port].filter((part) => part !== undefined).join(" "),
      }
    default:
      return { kind: "tool" as ApprovalKind, title: toolName(subject.toolName ?? tool), detail: rawArgs }
  }
}

export const toApprovalRequest = (params: ApprovalRequestParams, id: string, threadId: string): ApprovalRequest => ({
  id,
  threadId,
  provider: "muse",
  ...describe(params),
  input: toolInput(params.rawArgs),
  sessionScope: sessionScope(params),
})
