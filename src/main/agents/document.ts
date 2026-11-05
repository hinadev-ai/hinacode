import { CHART_GUIDE } from "@hinacode/artifacts"
import type { AgentCommand } from "../../shared/agent.ts"

export const DOCUMENT_COMMAND: AgentCommand = {
  trigger: "/",
  name: "document",
  description: "Publish a document with charts beside the thread",
  argumentHint: "<what to write>",
  builtin: true,
}

export const withDocumentCommand = (commands: ReadonlyArray<AgentCommand>) => [
  DOCUMENT_COMMAND,
  ...commands.filter(({ trigger, name }) => trigger !== DOCUMENT_COMMAND.trigger || name !== DOCUMENT_COMMAND.name),
]

const DOCUMENT_PROMPT = /^\/document(?:\s+([\s\S]*))?$/

const DOCUMENT_GUIDE = `<document-guide>
Publish this as a document with the hinacode \`publish_document\` tool. Write what the developer asks for after this guide, or, when they ask for nothing, what this conversation has just produced.

${CHART_GUIDE}
</document-guide>`

export const expandDocumentCommand = (prompt: string) => {
  const match = DOCUMENT_PROMPT.exec(prompt.trim())
  if (match === null) return prompt
  const request = match[1]?.trim() ?? ""
  return request === "" ? DOCUMENT_GUIDE : `${DOCUMENT_GUIDE}\n\n${request}`
}
