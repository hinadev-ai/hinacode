import type { Question } from "../../../shared/agent.ts"
import type { AsyncUserInputQuestion, ThreadItem } from "./protocol.ts"

export const toolName = (item: ThreadItem): string | undefined => {
  switch (item.type) {
    case "commandExecution":
      return "Bash"
    case "mcpToolCall":
      return item.tool
    case "fileChange":
      return "Edit"
    default:
      return undefined
  }
}

export const toolInput = (item: ThreadItem): unknown =>
  item.type === "fileChange" ? { path: item.changes.map((change) => change.path).join(", "), ...item } : item

export const toolResult = (
  item: ThreadItem,
  bufferedOutput: string | undefined,
): { output: unknown; isError: boolean } => {
  switch (item.type) {
    case "commandExecution":
      return {
        output: item.aggregatedOutput ?? bufferedOutput ?? item.status,
        isError: item.status !== "completed" || (item.exitCode !== null && item.exitCode !== 0),
      }
    case "mcpToolCall":
      return { output: item.error ?? item.result, isError: item.status !== "completed" }
    case "fileChange":
      return { output: item.status, isError: item.status !== "completed" }
    default:
      return { output: null, isError: false }
  }
}

export const toPostedQuestion = (question: AsyncUserInputQuestion): Question => ({
  id: question.title,
  header: "",
  question: question.title,
  options: (question.options ?? []).map((label) => ({ label, description: "" })),
  multiSelect: false,
  allowsText: true,
  secret: false,
})
