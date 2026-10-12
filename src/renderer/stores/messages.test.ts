import { beforeEach, expect, test } from "@effect/vitest"
import type { AgentEvent, ApprovalRequest, SecretRequest } from "../../shared/agent.ts"
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

const secretRequest: SecretRequest = { id: "s1", threadId, name: "demo.token", description: "Demo token" }

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
  if (history?.status !== "ready") throw new Error(`history is ${history?.status ?? "missing"}`)
  return history
}

test("keeps pushes from before, during and after the snapshot exactly once", async () => {
  const loading = store().load(threadId)
  // Captured in the snapshot, but delivered while the RPC resolves.
  store().receive(event(1, { type: "text_delta", text: "persisted prefix " }))
  store().receive(event(2, { type: "approval_requested", request: approval }))
  // Published after the snapshot was captured.
  store().receive(event(3, { type: "text_delta", text: "while loading " }))
  transcriptResponse.resolve({
    result: { messages: [assistant("persisted prefix ")], approvals: [approval], secretRequests: [], seq: 2 },
  })
  await loading
  store().receive(event(4, { type: "text_delta", text: "after load" }))
  store().receive(event(5, { type: "turn_completed" }))

  const history = ready()
  expect(history.messages[0]?.parts).toStrictEqual([
    { type: "text", text: "persisted prefix while loading after load" },
  ])
  expect(history.messages[0]?.completedAt).not.toBe(null)
  expect(history.approvals).toStrictEqual([])
})

test("replays message pushes buffered after the snapshot", async () => {
  const loading = store().load(threadId)
  store().receive({ type: "message.created", seq: 7, message: { ...assistant(""), id: "m2" } })
  store().receive({
    type: "message.updated",
    seq: 8,
    message: { ...assistant("closed"), completedAt: "2026-10-12T00:00:01.000Z" },
  })
  transcriptResponse.resolve({ result: { messages: [assistant("open")], approvals: [], secretRequests: [], seq: 6 } })
  await loading

  expect(ready().messages.map((message) => [message.id, message.parts])).toStrictEqual([
    ["m1", [{ type: "text", text: "closed" }]],
    ["m2", [{ type: "text", text: "" }]],
  ])
})

test("ignores pushes for threads that were never opened", () => {
  store().receive(event(1, { type: "text_delta", text: "unseen" }))
  expect(store().byThread).toStrictEqual({})
})

test("keeps a secret request until it is resolved or the turn ends", async () => {
  const loading = store().load(threadId)
  transcriptResponse.resolve({ result: { messages: [assistant("")], approvals: [], secretRequests: [], seq: 0 } })
  await loading
  store().receive(event(1, { type: "secret_requested", request: secretRequest }))
  expect(ready().secretRequests).toStrictEqual([secretRequest])
  store().receive(event(2, { type: "secret_resolved", requestId: "s1" }))
  expect(ready().secretRequests).toStrictEqual([])

  store().receive(event(3, { type: "secret_requested", request: { ...secretRequest, id: "s2" } }))
  store().receive(event(4, { type: "turn_failed", message: "boom" }))
  expect(ready().secretRequests).toStrictEqual([])
})
