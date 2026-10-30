import type { AgentEvent } from "../../../shared/agent.ts"
import { makeTranscriptBuilder } from "../importTranscript.ts"
import type { NativeSession, SessionHistory } from "../provider.ts"
import { toolInput, toolName, toolResult, toPostedQuestion } from "./items.ts"
import type { HistoryTurn, ThreadItem, ThreadListResponse, ThreadReadResponse } from "./protocol.ts"

const PREVIEW_LENGTH = 300

const shorten = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

const isoFromSeconds = (seconds: number) => new Date(seconds * 1000).toISOString()

export const toNativeSessions = (response: typeof ThreadListResponse.Type, cwd: string): ReadonlyArray<NativeSession> =>
  response.data
    .filter((thread) => thread.cwd === cwd)
    .map((thread) => ({
      sessionId: thread.id,
      title: shorten(thread.name ?? thread.preview, 120),
      preview: shorten(thread.preview, PREVIEW_LENGTH),
      branch: thread.gitInfo?.branch ?? null,
      updatedAt: isoFromSeconds(thread.updatedAt),
    }))

const itemEvents = (item: ThreadItem): ReadonlyArray<AgentEvent> => {
  switch (item.type) {
    case "agentMessage":
      return [
        { type: "text_delta", text: item.text },
        ...(item.questions
          ? [
              {
                type: "questions_posted" as const,
                text: item.text,
                questions: item.questions.map(toPostedQuestion),
              },
            ]
          : []),
      ]
    case "reasoning": {
      const text = (item.summary.length > 0 ? item.summary : item.content).join("\n\n")
      return text === "" ? [] : [{ type: "reasoning_delta", text }]
    }
    case "contextCompaction":
      return [
        {
          type: "compaction_updated",
          compaction: { status: "done", trigger: "auto", preTokens: null, postTokens: null },
        },
      ]
    default: {
      const name = toolName(item)
      if (name === undefined) return []
      return [
        { type: "tool_call_started", callId: item.id, name, input: toolInput(item) },
        { type: "tool_call_finished", callId: item.id, ...toolResult(item, undefined) },
        ...(item.type === "fileChange" && item.status === "completed"
          ? item.changes.map((change): AgentEvent => ({ type: "file_changed", path: change.path, diff: change.diff }))
          : []),
      ]
    }
  }
}

export const toImportedHistory = (
  { thread }: ThreadReadResponse,
  turns: ReadonlyArray<HistoryTurn>,
): SessionHistory => {
  const title = thread.name
  const model = thread.model
  if (turns.some((turn) => turn.itemsView !== "full")) return { title, model, messages: null }
  const transcript = makeTranscriptBuilder()
  for (const turn of turns) {
    const startedAt = isoFromSeconds(turn.startedAt ?? thread.createdAt)
    for (const raw of turn.items) {
      const item = raw as ThreadItem
      if (item.type === "userMessage") {
        const text = item.content
          .flatMap((input) => (input.type === "text" && input.text !== undefined ? [input.text] : []))
          .join("\n")
          .trim()
        if (text === "") transcript.endTurn()
        else transcript.prompt(text, startedAt)
        continue
      }
      for (const event of itemEvents(item)) transcript.event(event, startedAt)
    }
    if (turn.status === "completed") transcript.reachedForkPoint({ sessionId: thread.id, checkpoint: turn.id })
    transcript.endTurn(turn.completedAt === null ? undefined : isoFromSeconds(turn.completedAt))
  }
  const messages = transcript.finish()
  return { title, model, messages: messages.length === 0 ? null : messages }
}
