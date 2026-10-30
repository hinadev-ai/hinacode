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
