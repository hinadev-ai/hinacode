import type { Message, Thread } from "@shared/domain.ts"

/** A `call` made by a store under test, settled by the test when it chooses. */
export interface PendingCall {
  readonly method: string
  readonly payload: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/** Stands in for `@/lib/connection`'s `call`, so a test controls when and how each desktop answer arrives. */
export function fakeCall(calls: PendingCall[]) {
  return (method: string, payload: unknown) =>
    new Promise((resolve, reject) => calls.push({ method, payload, resolve, reject }))
}

/** Lets settled promises run their callbacks. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

export const message = (id: string, threadId = "t1"): Message => ({
  id,
  threadId,
  role: "user",
  parts: [],
  createdAt: "2026-10-16T00:00:00.000Z",
  completedAt: null,
  usage: null,
})

/** Only the fields the stores read; the rest of `Thread` does not matter to them. */
export const thread = (id: string, updatedAt: string, title = id) => ({ id, updatedAt, title }) as unknown as Thread
