import { isRunAgentTool, toolArgument } from "../../shared/agent.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export const spawningCallId = (messages: ReadonlyArray<Message>, prompt: string): string | undefined =>
  messages
    .flatMap((message) => message.parts)
    .findLast(
      (part): part is ToolCall =>
        part.type === "tool_call" &&
        part.status === "running" &&
        isRunAgentTool(part.name) &&
        toolArgument(part.input, "prompt") === prompt,
    )?.callId

export type SubagentModel =
  | { readonly kind: "chosen"; readonly model: string }
  | { readonly kind: "refused"; readonly message: string }

export const pickedSubagentModel = (input: {
  readonly agent: string
  readonly requested: string | undefined
  readonly threadModel: string | null
  readonly picked: ReadonlyArray<string>
}): SubagentModel => {
  const allowed = [...new Set([...(input.threadModel === null ? [] : [input.threadModel]), ...input.picked])]
  const model = input.requested ?? allowed[0]
  if (model !== undefined && allowed.includes(model)) return { kind: "chosen", model }
  if (input.picked.length === 0) {
    return {
      kind: "refused",
      message: `The user has not picked any ${input.agent} models for sub-agents. Ask them to pick some in Settings, Providers, ${input.agent}, Models in the picker.`,
    }
  }
  return {
    kind: "refused",
    message: `${model} is not among the ${input.agent} models the user picked. Use one of: ${allowed.join(", ")}.`,
  }
}
