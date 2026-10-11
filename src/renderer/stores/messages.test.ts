import assert from "node:assert/strict"
import { test } from "node:test"
import type { Message } from "../../shared/domain.ts"

const threadId = "t1"
const assistant: Message = {
  id: "m1",
  threadId,
  role: "assistant",
  parts: [{ type: "text", text: "persisted prefix " }],
  createdAt: "2026-10-12T00:00:00.000Z",
  completedAt: null,
  usage: null,
}

const responses = new Map<string, PromiseWithResolvers<unknown>>()
const respond = (method: string, result: unknown) => responses.get(method)!.resolve({ result })
Object.assign(globalThis, {
  window: {
    kkcode: {
      rpc: (method: string) => {
        const deferred = Promise.withResolvers<unknown>()
        responses.set(method, deferred)
        return deferred.promise
      },
    },
  },
})

const { useMessages } = await import("./messages.ts")
const store = () => useMessages.getState()

test("events streamed while the history loads stay in the transcript", async () => {
  const loading = store().load(threadId)
  store().applyEvent(threadId, { type: "text_delta", text: "while loading " })
  respond("messages.list", [assistant])
  respond("approvals.pending", [])
  await loading
  store().applyEvent(threadId, { type: "text_delta", text: "after load" })
  store().applyEvent(threadId, { type: "turn_completed" })

  const history = store().byThread[threadId]
  assert.ok(history?.status === "ready")
  assert.deepEqual(history.messages[0]?.parts, [{ type: "text", text: "persisted prefix while loading after load" }])
})
