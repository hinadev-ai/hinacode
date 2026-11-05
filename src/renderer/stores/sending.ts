import { create } from "zustand"
import { useThreads } from "./threads.ts"

interface SendingState {
  readonly threadIds: ReadonlySet<string>
}

export const useSending = create<SendingState>()(() => ({ threadIds: new Set() }))

const START_TIMEOUT_MS = 5000

const mark = (threadId: string) =>
  useSending.setState(({ threadIds }) => ({ threadIds: new Set(threadIds).add(threadId) }))

const unmark = (threadId: string) =>
  useSending.setState(({ threadIds }) => {
    const next = new Set(threadIds)
    next.delete(threadId)
    return { threadIds: next }
  })

const started = (threadId: string) => {
  const status = useThreads.getState().byId[threadId]?.status
  return status !== undefined && status !== "idle" && status !== "draft"
}

const unmarkOnceStarted = (threadId: string) => {
  if (started(threadId)) return unmark(threadId)
  const release = () => {
    unsubscribe()
    clearTimeout(timeout)
    unmark(threadId)
  }
  const unsubscribe = useThreads.subscribe(() => {
    if (started(threadId)) release()
  })
  const timeout = setTimeout(release, START_TIMEOUT_MS)
}

export async function trackSend<A>(threadId: string, send: () => Promise<A>) {
  mark(threadId)
  try {
    const result = await send()
    unmarkOnceStarted(threadId)
    return result
  } catch (cause) {
    unmark(threadId)
    throw cause
  }
}
