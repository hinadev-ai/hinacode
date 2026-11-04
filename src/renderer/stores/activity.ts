import { create } from "zustand"
import type { AgentEvent } from "../../shared/agent.ts"
import { describeToolCall } from "../lib/toolCall.ts"

export interface ThreadLine {
  readonly text: string
  readonly code: boolean
  readonly kind: "activity" | "ask" | "failure"
}

type Lines = Readonly<Record<string, ThreadLine>>

interface ActivityState {
  readonly byThreadId: Lines
  readonly receive: (threadId: string, event: AgentEvent) => void
  readonly forget: (threadId: string) => void
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? ""

const withoutPayload = (message: string) => message.replace(/\s*\{".*$/, "") || message

const without = (lines: Lines, threadId: string) => {
  const { [threadId]: _forgotten, ...rest } = lines
  return rest
}

const toolLine = (event: Extract<AgentEvent, { type: "tool_call_started" }>) => {
  const { name, summary } = describeToolCall(event)
  if (summary === "") return name
  return name === "Bash" ? firstLine(summary) : `${name} ${firstLine(summary)}`
}

const nextLine = (current: ThreadLine | undefined, event: AgentEvent): ThreadLine | null | undefined => {
  switch (event.type) {
    case "tool_call_started":
      return current?.kind === "ask" ? undefined : { text: toolLine(event), code: true, kind: "activity" }
    case "approval_requested":
      return { text: firstLine(event.request.detail) || event.request.title, code: true, kind: "ask" }
    case "approval_resolved":
      return current?.kind === "ask" ? { ...current, kind: "activity" } : undefined
    case "question_requested": {
      const question = event.request.questions[0]
      return { text: firstLine(question?.question ?? "") || (question?.header ?? ""), code: false, kind: "ask" }
    }
    case "secret_requested":
      return { text: event.request.name, code: true, kind: "ask" }
    case "question_resolved":
    case "secret_resolved":
    case "turn_completed":
    case "turn_limited":
      return null
    case "turn_failed":
      return event.stopped ? null : { text: withoutPayload(firstLine(event.message)), code: false, kind: "failure" }
    default:
      return undefined
  }
}

export const useActivity = create<ActivityState>()((set) => ({
  byThreadId: {},
  forget: (threadId) => set((state) => ({ byThreadId: without(state.byThreadId, threadId) })),
  receive: (threadId, event) =>
    set((state) => {
      const next = nextLine(state.byThreadId[threadId], event)
      if (next === undefined) return state
      if (next === null || next.text === "") return { byThreadId: without(state.byThreadId, threadId) }
      return { byThreadId: { ...state.byThreadId, [threadId]: next } }
    }),
}))
