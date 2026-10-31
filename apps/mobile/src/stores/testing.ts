import type { Message, Thread } from "@shared/domain.ts"

export interface PendingCall {
  readonly method: string
  readonly payload: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export function fakeCall(calls: PendingCall[]) {
  return (method: string, payload: unknown) =>
    new Promise((resolve, reject) => calls.push({ method, payload, resolve, reject }))
}

export const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

export const message = (id: string, threadId = "t1"): Message => ({
  id,
  threadId,
  role: "user",
  parts: [],
  createdAt: "2026-10-16T00:00:00.000Z",
  completedAt: null,
  usage: null,
  forkPoint: null,
})

export const thread = (id: string, updatedAt: string, title = id) => ({ id, updatedAt, title }) as unknown as Thread
