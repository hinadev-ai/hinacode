import type { ApprovalRequest, QuestionRequest } from "@shared/agent.ts"
import type { Thread } from "@shared/domain.ts"
import type { ThreadHistory } from "@/stores/messages"

export type OpenRequest =
  | { readonly kind: "approval"; readonly request: ApprovalRequest }
  | { readonly kind: "question"; readonly request: QuestionRequest }

export function openRequests(history: ThreadHistory | undefined): readonly OpenRequest[] {
  if (history?.status !== "ready") return []
  return [
    ...history.approvals.map((request) => ({ kind: "approval", request }) as const),
    ...history.questions.map((request) => ({ kind: "question", request }) as const),
  ]
}

export const threadsWithRequests = (histories: Readonly<Record<string, ThreadHistory>>) =>
  Object.keys(histories)
    .filter((threadId) => openRequests(histories[threadId]).length > 0)
    .sort()
    .join(" ")

const newestFirst = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

export function waitingThreads(threads: readonly Thread[], requesting: string) {
  const ids = new Set(requesting.split(" "))
  return threads
    .filter(
      (thread) => thread.status !== "archived" && (thread.status === "awaiting_approval" || ids.has(thread.id)),
    )
    .sort(newestFirst)
}

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export function homeSummary(threads: readonly Thread[], requesting: string, now: number) {
  const waiting = waitingThreads(threads, requesting)
  const waitingIds = new Set(waiting.map((thread) => thread.id))
  const today = new Date(now)
  return {
    waiting,
    running: threads.filter((thread) => thread.status === "running" && !waitingIds.has(thread.id)).sort(newestFirst),
    doneToday: threads.filter(
      (thread) =>
        thread.status === "idle" && thread.interruptedAt === null && sameLocalDay(new Date(thread.updatedAt), today),
    ).length,
  }
}

const pad = (value: number) => String(value).padStart(2, "0")

export function stopwatch(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const clock = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
  return hours === 0 ? clock : `${hours}:${clock}`
}
