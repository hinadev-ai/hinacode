import { create } from "zustand"
import type { AgentEvent, ApprovalRequest, QuestionRequest, SecretRequest } from "../../shared/agent.ts"
import { type TranscriptPush, transcriptThreadId } from "../../shared/contract.ts"
import type { Message } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { callPromise } from "../lib/rpc.ts"

const STREAM_PUBLICATION_INTERVAL_MS = 100
const CACHED_HISTORY_LIMIT = 8

type ReadyHistory = {
  readonly status: "ready"
  readonly messages: ReadonlyArray<Message>
  readonly approvals: ReadonlyArray<ApprovalRequest>
  readonly questions: ReadonlyArray<QuestionRequest>
  readonly secretRequests: ReadonlyArray<SecretRequest>
}

export type ThreadHistory =
  | { readonly status: "loading"; readonly loadId: symbol; readonly pending: ReadonlyArray<TranscriptPush> }
  | { readonly status: "error"; readonly message: string }
  | ReadyHistory

interface MessagesState {
  readonly byThread: Readonly<Record<string, ThreadHistory>>
  readonly load: (threadId: string) => Promise<void>
  readonly reload: (threadId: string) => Promise<void>
  readonly unload: (threadId: string) => void
  readonly receive: (push: TranscriptPush) => void
}

export const useMessages = create<MessagesState>()((set, get) => {
  const streamWindows = new Map<string, StreamWindow>()
  const takeHeld = (threadId: string) => {
    const stream = streamWindows.get(threadId)
    if (stream === undefined) return []
    clearTimeout(stream.timer)
    streamWindows.delete(threadId)
    return stream.held
  }
  const receivedSeqs = new Map<string, number>()
  const setHistory = (threadId: string, update: (history: ThreadHistory | undefined) => ThreadHistory | undefined) =>
    set((state) => {
      const history = state.byThread[threadId]
      const next = update(history)
      return next === undefined || next === history ? state : { byThread: { ...state.byThread, [threadId]: next } }
    })

  const openStreamWindow = (threadId: string, type: DeltaType) => {
    const publishOrClose = () => {
      const pushes = stream.held
      if (pushes.length === 0) {
        streamWindows.delete(threadId)
        return
      }
      stream.held = []
      stream.timer = setTimeout(publishOrClose, STREAM_PUBLICATION_INTERVAL_MS)
      setHistory(threadId, (history) => (history?.status === "ready" ? pushes.reduce(applyPush, history) : history))
    }
    const stream: StreamWindow = { type, held: [], timer: setTimeout(publishOrClose, STREAM_PUBLICATION_INTERVAL_MS) }
    streamWindows.set(threadId, stream)
  }

  const leastRecentlyViewedFirst: string[] = []
  const forget = (threadIds: ReadonlyArray<string>) => {
    if (threadIds.length === 0) return
    for (const threadId of threadIds) {
      takeHeld(threadId)
      receivedSeqs.delete(threadId)
      const index = leastRecentlyViewedFirst.indexOf(threadId)
      if (index !== -1) leastRecentlyViewedFirst.splice(index, 1)
    }
    set((state) => ({
      byThread: Object.fromEntries(
        Object.entries(state.byThread).filter(([threadId]) => !threadIds.includes(threadId)),
      ),
    }))
  }
  const markViewed = (threadId: string) => {
    const index = leastRecentlyViewedFirst.indexOf(threadId)
    if (index !== -1) leastRecentlyViewedFirst.splice(index, 1)
    leastRecentlyViewedFirst.push(threadId)
    forget(leastRecentlyViewedFirst.slice(0, -CACHED_HISTORY_LIMIT))
  }
  const fetchHistory = async (threadId: string): Promise<void> => {
    takeHeld(threadId)
    receivedSeqs.delete(threadId)
    const loadId = Symbol(threadId)
    setHistory(threadId, () => ({ status: "loading", loadId, pending: [] }))
    const stillLoading = () => {
      const history = get().byThread[threadId]
      return history?.status === "loading" && history.loadId === loadId ? history : undefined
    }
    try {
      const { seq, ...snapshot } = await callPromise("threads.transcript", { threadId })
      const loading = stillLoading()
      if (loading === undefined) return
      const settled = replayAfterSnapshot({ status: "ready", ...snapshot }, seq, loading.pending)
      if (settled === undefined) return await fetchHistory(threadId)
      receivedSeqs.set(threadId, settled.lastSeq)
      setHistory(threadId, () => settled.ready)
    } catch (cause) {
      if (stillLoading() === undefined) return
      setHistory(threadId, () => ({ status: "error", message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  return {
    byThread: {},

    load: async (threadId) => {
      markViewed(threadId)
      const current = get().byThread[threadId]
      if (current !== undefined && current.status !== "error") return
      await fetchHistory(threadId)
    },

    reload: async (threadId) => {
      if (get().byThread[threadId] !== undefined) await fetchHistory(threadId)
    },

    unload: (threadId) => forget([threadId]),

    receive: (push) => {
      const threadId = transcriptThreadId(push)
      const current = get().byThread[threadId]
      if (current?.status === "ready") {
        const lastSeq = receivedSeqs.get(threadId) ?? 0
        if (push.seq <= lastSeq) return
        if (push.seq !== lastSeq + 1) return void fetchHistory(threadId)
        receivedSeqs.set(threadId, push.seq)
      }
      const type = current?.status === "ready" ? deltaType(push) : undefined
      const stream = streamWindows.get(threadId)
      if (type !== undefined && stream?.type === type) {
        stream.held.push(push)
        return
      }
      const pushes = takeHeld(threadId)
      setHistory(threadId, (history) => {
        switch (history?.status) {
          case "loading":
            return { ...history, pending: [...history.pending, push] }
          case "ready":
            return applyPush(pushes.reduce(applyPush, history), push)
          default:
            return history
        }
      })
      if (type !== undefined) openStreamWindow(threadId, type)
    },
  }
})

function replayAfterSnapshot(
  snapshot: ReadyHistory,
  snapshotSeq: number,
  pending: ReadonlyArray<TranscriptPush>,
): { readonly ready: ReadyHistory; readonly lastSeq: number } | undefined {
  const replay = pending.filter((push) => push.seq > snapshotSeq)
  if (replay.some((push, index) => push.seq !== snapshotSeq + index + 1)) return undefined
  return { ready: replay.reduce(applyPush, snapshot), lastSeq: replay.at(-1)?.seq ?? snapshotSeq }
}

type DeltaType = "text_delta" | "reasoning_delta"
type StreamWindow = { readonly type: DeltaType; held: TranscriptPush[]; timer: ReturnType<typeof setTimeout> }
const deltaType = (push: TranscriptPush): DeltaType | undefined =>
  push.type === "thread.event" && (push.event.type === "text_delta" || push.event.type === "reasoning_delta")
    ? push.event.type
    : undefined

function applyPush(history: ReadyHistory, push: TranscriptPush): ReadyHistory {
  switch (push.type) {
    case "message.created":
      return { ...history, messages: [...history.messages, push.message] }
    case "message.updated": {
      const index = history.messages.findIndex((existing) => existing.id === push.message.id)
      return index === -1 ? history : { ...history, messages: history.messages.with(index, push.message) }
    }
    case "thread.event": {
      const approvals = foldApprovals(history.approvals, push.event)
      const questions = foldQuestions(history.questions, push.event)
      const secretRequests = foldSecretRequests(history.secretRequests, push.event)
      const messages = foldTranscript(history.messages, push.event, new Date().toISOString())
      if (
        approvals === history.approvals &&
        questions === history.questions &&
        secretRequests === history.secretRequests &&
        messages === history.messages
      ) {
        return history
      }
      return { ...history, approvals, questions, secretRequests, messages }
    }
  }
}

function foldApprovals(approvals: ReadonlyArray<ApprovalRequest>, event: AgentEvent): ReadonlyArray<ApprovalRequest> {
  switch (event.type) {
    case "approval_requested":
      return [...approvals, event.request]
    case "approval_resolved":
      return approvals.filter((request) => request.id !== event.requestId)
    case "turn_completed":
    case "turn_failed":
      return approvals.length === 0 ? approvals : []
    default:
      return approvals
  }
}

function foldQuestions(questions: ReadonlyArray<QuestionRequest>, event: AgentEvent): ReadonlyArray<QuestionRequest> {
  switch (event.type) {
    case "question_requested":
      return [...questions, event.request]
    case "question_resolved":
      return questions.filter((request) => request.id !== event.requestId)
    case "turn_completed":
    case "turn_failed":
    case "turn_limited":
      return questions.length === 0 ? questions : []
    default:
      return questions
  }
}

function foldSecretRequests(requests: ReadonlyArray<SecretRequest>, event: AgentEvent): ReadonlyArray<SecretRequest> {
  switch (event.type) {
    case "secret_requested":
      return [...requests, event.request]
    case "secret_resolved":
      return requests.filter((request) => request.id !== event.requestId)
    case "turn_completed":
    case "turn_failed":
      return requests.length === 0 ? requests : []
    default:
      return requests
  }
}
