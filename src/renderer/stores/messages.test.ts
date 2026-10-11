import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import type { AgentEvent, ApprovalRequest } from "../../shared/agent.ts"
import type { TranscriptPush } from "../../shared/contract.ts"
import type { Message } from "../../shared/domain.ts"

const threadId = "t1"
const assistant = (text: string): Message => ({
  id: "m1",
  threadId,
  role: "assistant",
  parts: [{ type: "text", text }],
  createdAt: "2026-10-12T00:00:00.000Z",
  completedAt: null,
  usage: null,
})
const approval: ApprovalRequest = {
  id: "a1",
  threadId,
  provider: "claude",
  kind: "command",
  title: "Run ls",
  detail: "ls",
}

let transcriptResponse = Promise.withResolvers<unknown>()
Object.assign(globalThis, { window: { kkcode: { rpc: () => transcriptResponse.promise } } })
const { useMessages } = await import("./messages.ts")
const store = () => useMessages.getState()

beforeEach(() => {
  transcriptResponse = Promise.withResolvers()
  useMessages.setState({ byThread: {} })
})

const event = (seq: number, agentEvent: AgentEvent): TranscriptPush => ({
  type: "thread.event",
  seq,
  threadId,
  event: agentEvent,
})

const ready = () => {
  const history = store().byThread[threadId]
  assert.ok(history?.status === "ready")
  return history
}

test("keeps pushes from before, during and after the snapshot exactly once", async () => {
  const loading = store().load(threadId)
  // Captured in the snapshot, but delivered while the RPC resolves.
  store().receive(event(1, { type: "text_delta", text: "persisted prefix " }))
  store().receive(event(2, { type: "approval_requested", request: approval }))
  // Published after the snapshot was captured.
  store().receive(event(3, { type: "text_delta", text: "while loading " }))
  transcriptResponse.resolve({ result: { messages: [assistant("persisted prefix ")], approvals: [approval], seq: 2 } })
  await loading
  store().receive(event(4, { type: "text_delta", text: "after load" }))
  store().receive(event(5, { type: "turn_completed" }))

  const history = ready()
  assert.deepEqual(history.messages[0]?.parts, [{ type: "text", text: "persisted prefix while loading after load" }])
  assert.notEqual(history.messages[0]?.completedAt, null)
  assert.deepEqual(history.approvals, [])
})

test("replays message pushes buffered after the snapshot", async () => {
  const loading = store().load(threadId)
  store().receive({ type: "message.created", seq: 7, message: { ...assistant(""), id: "m2" } })
  store().receive({
    type: "message.updated",
    seq: 8,
    message: { ...assistant("closed"), completedAt: "2026-10-12T00:00:01.000Z" },
  })
  transcriptResponse.resolve({ result: { messages: [assistant("open")], approvals: [], seq: 6 } })
  await loading

  assert.deepEqual(
    ready().messages.map((message) => [message.id, message.parts]),
    [
      ["m1", [{ type: "text", text: "closed" }]],
      ["m2", [{ type: "text", text: "" }]],
    ],
  )
})

test("ignores pushes for threads that were never opened", () => {
  store().receive(event(1, { type: "text_delta", text: "unseen" }))
  assert.deepEqual(store().byThread, {})
})
