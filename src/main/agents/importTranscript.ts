import type { AgentEvent, ForkPoint } from "../../shared/agent.ts"
import type { Message } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import type { ImportedMessage } from "./provider.ts"

export const makeTranscriptBuilder = () => {
  let messages: ReadonlyArray<Message> = []
  let turnOpen = false
  let turnEndedAt = ""
  let pendingForkPoint: ForkPoint | null = null

  const add = (role: Message["role"], parts: Message["parts"], at: string) => {
    messages = [
      ...messages,
      {
        id: String(messages.length),
        threadId: "",
        role,
        parts,
        createdAt: at,
        completedAt: role === "user" ? at : null,
        usage: null,
        forkPoint: null,
      },
    ]
  }

  const endTurn = (at = turnEndedAt) => {
    if (!turnOpen) return
    turnOpen = false
    messages = foldTranscript(
      messages,
      { type: "turn_completed", ...(pendingForkPoint && { forkPoint: pendingForkPoint }) },
      at,
    )
    pendingForkPoint = null
  }

  return {
    prompt: (text: string, at: string) => {
      endTurn()
      add("user", [{ type: "text", text }], at)
    },
    event: (event: AgentEvent, at: string) => {
      if (!turnOpen) add("assistant", [], at)
      turnOpen = true
      turnEndedAt = at
      messages = foldTranscript(messages, event, at)
    },
    reachedForkPoint: (point: ForkPoint) => {
      pendingForkPoint = point
    },
    endTurn,
    finish: (): ReadonlyArray<ImportedMessage> => {
      endTurn()
      return messages.map(({ role, parts, createdAt, completedAt, forkPoint }) => ({
        role,
        parts,
        createdAt,
        completedAt,
        forkPoint,
      }))
    },
  }
}
