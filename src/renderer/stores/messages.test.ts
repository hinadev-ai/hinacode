import { afterEach, beforeEach, expect, test, vi } from "@effect/vitest"
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
Object.assign(globalThis, { window: { hinacode: { rpc: () => transcriptResponse.promise } } })
const { useMessages } = await import("./messages.ts")
const store = () => useMessages.getState()

beforeEach(() => {
  transcriptResponse = Promise.withResolvers()
  useMessages.setState({ byThread: {} })
})

afterEach(() => {
  for (const id of Object.keys(store().byThread)) store().unload(id)
  vi.useRealTimers()
})

const event = (seq: number, agentEvent: AgentEvent, id = threadId): TranscriptPush => ({
  type: "thread.event",
  seq,
  threadId: id,
  event: agentEvent,
})

const ready = (id = threadId) => {
  const history = store().byThread[id]
  if (history?.status !== "ready") throw new Error(`history is ${history?.status ?? "missing"}`)
  return history
}

const loadReady = async (
  id = threadId,
  messages = [{ ...assistant(""), threadId: id }],
  approvals: ApprovalRequest[] = [],
) => {
  transcriptResponse = Promise.withResolvers()
  const loading = store().load(id)
  transcriptResponse.resolve({ result: { messages, approvals, questions: [], secretRequests: [], seq: 0 } })
  await loading
  vi.useFakeTimers()
}

test("keeps pushes from before, during and after the snapshot exactly once", async () => {
  const loading = store().load(threadId)
  // Captured in the snapshot, but delivered while the RPC resolves.
  store().receive(event(1, { type: "text_delta", text: "persisted prefix " }))
  store().receive(event(2, { type: "approval_requested", request: approval }))
  // Published after the snapshot was captured.
  store().receive(event(3, { type: "text_delta", text: "while loading " }))
  transcriptResponse.resolve({
    result: {
      messages: [assistant("persisted prefix ")],
      approvals: [approval],
      questions: [],
      secretRequests: [],
      seq: 2,
    },
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
  transcriptResponse.resolve({
    result: { messages: [assistant("open")], approvals: [], questions: [], secretRequests: [], seq: 6 },
  })
  await loading

  expect(ready().messages.map((message) => [message.id, message.parts])).toStrictEqual([
    ["m1", [{ type: "text", text: "closed" }]],
    ["m2", [{ type: "text", text: "" }]],
  ])
})

test("drops pushes the snapshot already holds when the reply overtakes them", async () => {
  const loading = store().load(threadId)
  transcriptResponse.resolve({
    result: { messages: [assistant("ab")], approvals: [], questions: [], secretRequests: [], seq: 2 },
  })
  await loading
  vi.useFakeTimers()
  store().receive(event(1, { type: "text_delta", text: "a" }))
  store().receive(event(2, { type: "text_delta", text: "b" }))
  store().receive(event(3, { type: "text_delta", text: "c" }))
  vi.runAllTimers()

  expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "abc" }])
})

test("ignores pushes for threads that were never opened", () => {
  store().receive(event(1, { type: "text_delta", text: "unseen" }))
  expect(store().byThread).toStrictEqual({})
})

test("keeps a secret request until it is resolved or the turn ends", async () => {
  const loading = store().load(threadId)
  transcriptResponse.resolve({
    result: { messages: [assistant("")], approvals: [], questions: [], secretRequests: [], seq: 0 },
  })
  await loading
  store().receive(event(1, { type: "secret_requested", request: secretRequest }))
  expect(ready().secretRequests).toStrictEqual([secretRequest])
  store().receive(event(2, { type: "secret_resolved", requestId: "s1" }))
  expect(ready().secretRequests).toStrictEqual([])

  store().receive(event(3, { type: "secret_requested", request: { ...secretRequest, id: "s2" } }))
  store().receive(event(4, { type: "turn_failed", message: "boom" }))
  expect(ready().secretRequests).toStrictEqual([])
})

test("batches sustained text deltas and publishes the complete turn immediately", async () => {
  const loading = store().load(threadId)
  transcriptResponse.resolve({
    result: { messages: [assistant("")], approvals: [approval], questions: [], secretRequests: [], seq: 0 },
  })
  await loading

  vi.useFakeTimers()
  let publications = 0
  const unsubscribe = useMessages.subscribe(() => publications++)
  try {
    store().receive(event(1, { type: "text_delta", text: "a" }))
    vi.advanceTimersByTime(20)
    store().receive(event(2, { type: "text_delta", text: "b" }))
    vi.advanceTimersByTime(20)
    store().receive(event(3, { type: "text_delta", text: "c" }))
    vi.advanceTimersByTime(60)

    const firstWindowPublications = publications
    expect.soft(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "abc" }])

    vi.advanceTimersByTime(10)
    store().receive(event(4, { type: "text_delta", text: "d" }))
    vi.advanceTimersByTime(20)
    store().receive(event(5, { type: "text_delta", text: "e" }))
    const beforeCompletionPublications = publications
    store().receive(event(6, { type: "turn_completed" }))

    expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "abcde" }])
    expect(ready().messages[0]?.completedAt).toEqual(expect.any(String))
    expect(ready().approvals).toStrictEqual([])
    const completedPublications = publications
    vi.runAllTimers()
    expect(publications).toBe(completedPublications)
    expect([firstWindowPublications, beforeCompletionPublications, completedPublications]).toStrictEqual([1, 1, 2])
  } finally {
    unsubscribe()
    store().unload(threadId)
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

test.each(["text_delta", "reasoning_delta"] satisfies AgentEvent["type"][])(
  "%s publishes at the first delta's 100 ms deadline",
  async (type) => {
    await loadReady()
    const published: unknown[] = []
    const unsubscribe = useMessages.subscribe(() => published.push(ready().messages[0]?.parts))
    try {
      store().receive(event(1, { type, text: "a" }))
      vi.advanceTimersByTime(30)
      store().receive(event(2, { type, text: "b" }))
      vi.advanceTimersByTime(69)
      expect(published).toStrictEqual([])
      store().receive(event(3, { type, text: "c" }))
      vi.advanceTimersByTime(1)
      const parts =
        type === "text_delta"
          ? [{ type: "text", text: "abc" }]
          : [
              { type: "text", text: "" },
              { type: "reasoning", text: "abc" },
            ]
      expect(published).toStrictEqual([parts])
      expect(vi.getTimerCount()).toBe(0)

      vi.advanceTimersByTime(500)
      store().receive(event(4, { type, text: "d" }))
      vi.advanceTimersByTime(99)
      expect(published).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(published).toHaveLength(2)
      expect(ready().messages[0]?.parts.at(-1)).toStrictEqual({
        type: type === "text_delta" ? "text" : "reasoning",
        text: "abcd",
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unsubscribe()
    }
  },
)

test("approval request and resolution publish pending text with the approval state in one update", async () => {
  await loadReady()
  const published: unknown[] = []
  const unsubscribe = useMessages.subscribe(() =>
    published.push({
      parts: ready().messages[0]?.parts,
      approvals: ready().approvals,
    }),
  )
  try {
    store().receive(event(1, { type: "text_delta", text: "before request" }))
    store().receive(event(2, { type: "approval_requested", request: approval }))
    expect(published).toStrictEqual([
      {
        parts: [{ type: "text", text: "before request" }],
        approvals: [approval],
      },
    ])
    expect(vi.getTimerCount()).toBe(0)

    store().receive(event(3, { type: "text_delta", text: " and resolution" }))
    store().receive(event(4, { type: "approval_resolved", requestId: approval.id }))
    expect(published).toStrictEqual([
      { parts: [{ type: "text", text: "before request" }], approvals: [approval] },
      { parts: [{ type: "text", text: "before request and resolution" }], approvals: [] },
    ])
    vi.runAllTimers()
    expect(published).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    unsubscribe()
  }
})

test.each([
  { type: "turn_completed", usage: { inputTokens: 10, outputTokens: 20 } },
  { type: "turn_failed", message: "provider stopped" },
] satisfies AgentEvent[])(
  "$type flushes reasoning, clears approvals and closes running tools synchronously",
  async (terminal) => {
    await loadReady(
      threadId,
      [
        {
          ...assistant(""),
          parts: [{ type: "tool_call", callId: "c1", name: "shell", input: "ls", status: "running" }],
        },
      ],
      [approval],
    )
    const published: unknown[] = []
    const unsubscribe = useMessages.subscribe(() => published.push(ready()))
    try {
      store().receive(event(1, { type: "reasoning_delta", text: "last thought" }))
      store().receive(event(2, terminal))
      expect(published).toHaveLength(1)
      expect(ready().messages[0]?.parts).toStrictEqual([
        { type: "tool_call", callId: "c1", name: "shell", input: "ls", status: "error" },
        { type: "reasoning", text: "last thought" },
        ...(terminal.type === "turn_failed" ? [{ type: "text", text: "**Error:** provider stopped" }] : []),
      ])
      expect(ready().messages[0]?.completedAt).toEqual(expect.any(String))
      expect(ready().messages[0]?.usage).toStrictEqual(terminal.type === "turn_completed" ? terminal.usage : null)
      expect(ready().approvals).toStrictEqual([])
      expect(vi.getTimerCount()).toBe(0)
      vi.runAllTimers()
      expect(published).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  },
)

test("tool, reasoning, file and session boundaries retain part order and publish together", async () => {
  await loadReady()
  const published: unknown[] = []
  const unsubscribe = useMessages.subscribe(() => published.push(ready().messages[0]?.parts))
  try {
    store().receive(event(1, { type: "text_delta", text: "intro" }))
    store().receive(event(2, { type: "tool_call_started", callId: "c1", name: "shell", input: "ls" }))
    expect(published).toHaveLength(1)
    expect(ready().messages[0]?.parts).toStrictEqual([
      { type: "text", text: "intro" },
      { type: "tool_call", callId: "c1", name: "shell", input: "ls", status: "running" },
    ])
    store().receive(event(3, { type: "text_delta", text: "after tool" }))
    store().receive(event(4, { type: "reasoning_delta", text: "think" }))
    expect(published).toHaveLength(2)
    expect(ready().messages[0]?.parts.slice(-2)).toStrictEqual([
      { type: "text", text: "after tool" },
      { type: "reasoning", text: "think" },
    ])
    store().receive(event(5, { type: "reasoning_delta", text: " more" }))
    vi.advanceTimersByTime(100)
    expect(published).toHaveLength(3)
    store().receive(event(6, { type: "text_delta", text: "answer" }))
    store().receive(event(7, { type: "file_changed", path: "src/a.ts", diff: "+answer" }))
    expect(published).toHaveLength(4)
    store().receive(event(8, { type: "text_delta", text: "tail" }))
    store().receive(event(9, { type: "tool_call_finished", callId: "c1", output: "files", isError: false }))
    expect(published).toHaveLength(5)
    store().receive(event(10, { type: "text_delta", text: " end" }))
    store().receive(event(11, { type: "session_bound", providerSessionId: "s1" }))
    expect(published).toHaveLength(6)
    expect(ready().messages[0]?.parts).toStrictEqual([
      { type: "text", text: "intro" },
      { type: "tool_call", callId: "c1", name: "shell", input: "ls", status: "done", output: "files" },
      { type: "text", text: "after tool" },
      { type: "reasoning", text: "think more" },
      { type: "text", text: "answer" },
      { type: "file_change", path: "src/a.ts", diff: "+answer" },
      { type: "text", text: "tail end" },
    ])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    unsubscribe()
  }
})

test("reasoning followed by text creates a synchronous boundary", async () => {
  await loadReady()
  store().receive(event(1, { type: "reasoning_delta", text: "think" }))
  store().receive(event(2, { type: "reasoning_delta", text: " first" }))
  store().receive(event(3, { type: "text_delta", text: "answer" }))
  expect(ready().messages[0]?.parts).toStrictEqual([
    { type: "text", text: "" },
    { type: "reasoning", text: "think first" },
    { type: "text", text: "answer" },
  ])
  expect(vi.getTimerCount()).toBe(0)
})

test("message replacement wins over pending deltas before steering opens another assistant message", async () => {
  await loadReady()
  const published: unknown[] = []
  const unsubscribe = useMessages.subscribe(() => published.push(ready().messages))
  try {
    store().receive(event(1, { type: "text_delta", text: "stale draft" }))
    const replaced = { ...assistant("authoritative"), completedAt: "2026-10-12T00:00:01.000Z" }
    store().receive({ type: "message.updated", seq: 2, message: replaced })
    expect(published).toStrictEqual([[replaced]])
    expect(vi.getTimerCount()).toBe(0)
    store().receive(event(3, { type: "text_delta", text: " before steer" }))
    const user: Message = { ...assistant("steer"), id: "u1", role: "user" }
    store().receive({ type: "message.created", seq: 4, message: user })
    expect(published).toHaveLength(2)
    expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "authoritative before steer" }])
    const next = { ...assistant(""), id: "m2" }
    store().receive({ type: "message.created", seq: 5, message: next })
    store().receive(event(6, { type: "text_delta", text: "new response" }))
    store().receive(event(7, { type: "turn_completed" }))
    expect(published).toHaveLength(4)
    expect(ready().messages.map((message) => [message.id, message.parts])).toStrictEqual([
      ["m1", [{ type: "text", text: "authoritative before steer" }]],
      ["u1", [{ type: "text", text: "steer" }]],
      ["m2", [{ type: "text", text: "new response" }]],
    ])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    unsubscribe()
  }
})

test("interleaved threads keep independent deadlines and synchronous boundaries", async () => {
  await loadReady()
  await loadReady("t2")
  store().receive(event(1, { type: "text_delta", text: "one" }))
  vi.advanceTimersByTime(20)
  store().receive(event(1, { type: "text_delta", text: "two" }, "t2"))
  vi.advanceTimersByTime(20)
  store().receive(event(2, { type: "text_delta", text: " more" }))
  vi.advanceTimersByTime(60)
  expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "one more" }])
  expect(ready("t2").messages[0]?.parts).toStrictEqual([{ type: "text", text: "" }])
  store().receive(event(3, { type: "text_delta", text: " final" }))
  store().receive(event(4, { type: "approval_requested", request: approval }))
  expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "one more final" }])
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(19)
  expect(ready("t2").messages[0]?.parts).toStrictEqual([{ type: "text", text: "" }])
  vi.advanceTimersByTime(1)
  expect(ready("t2").messages[0]?.parts).toStrictEqual([{ type: "text", text: "two" }])
  expect(vi.getTimerCount()).toBe(0)
})

test("loading keeps raw text and reasoning pushes until snapshot sequence filtering", async () => {
  vi.useFakeTimers()
  const loading = store().load(threadId)
  const pushes = [
    event(1, { type: "text_delta", text: "prefix" }),
    event(2, { type: "reasoning_delta", text: "captured thought" }),
    event(3, { type: "reasoning_delta", text: " later thought" }),
    event(4, { type: "text_delta", text: "after snapshot" }),
  ]
  for (const push of pushes) store().receive(push)
  vi.advanceTimersByTime(500)
  expect(store().byThread[threadId]).toStrictEqual({ status: "loading", loadId: expect.any(Symbol), pending: pushes })
  expect(vi.getTimerCount()).toBe(0)
  transcriptResponse.resolve({
    result: {
      messages: [
        {
          ...assistant("prefix"),
          parts: [
            { type: "text", text: "prefix" },
            { type: "reasoning", text: "captured thought" },
          ],
        },
      ],
      approvals: [],
      questions: [],
      secretRequests: [],
      seq: 2,
    },
  })
  await loading
  expect(ready().messages[0]?.parts).toStrictEqual([
    { type: "text", text: "prefix" },
    { type: "reasoning", text: "captured thought later thought" },
    { type: "text", text: "after snapshot" },
  ])
  store().receive(event(5, { type: "text_delta", text: " live" }))
  vi.advanceTimersByTime(100)
  expect(ready().messages[0]?.parts.at(-1)).toStrictEqual({ type: "text", text: "after snapshot live" })
})

test("unload cancels pending deltas and reload uses the authoritative snapshot", async () => {
  await loadReady()
  store().receive(event(1, { type: "text_delta", text: "discard me" }))
  vi.advanceTimersByTime(30)
  store().unload(threadId)
  expect(vi.getTimerCount()).toBe(0)
  expect(store().byThread[threadId]).toBeUndefined()
  store().receive(event(2, { type: "text_delta", text: "unloaded" }))
  await loadReady(threadId, [assistant("snapshot")])
  store().receive(event(3, { type: "text_delta", text: " fresh" }))
  vi.advanceTimersByTime(70)
  expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "snapshot" }])
  vi.advanceTimersByTime(30)
  expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "snapshot fresh" }])
  store().receive(event(4, { type: "reasoning_delta", text: "discard thought" }))
  store().unload(threadId)
  vi.runAllTimers()
  expect(store().byThread[threadId]).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

test("reconciles pending questions across snapshot, resolution, and turn failure", async () => {
  const request = { id: "q1", threadId, provider: "codex" as const, questions: [] }
  const loading = store().load(threadId)
  transcriptResponse.resolve({
    result: { messages: [assistant("")], approvals: [], questions: [request], secretRequests: [], seq: 1 },
  })
  await loading
  expect(ready().questions).toStrictEqual([request])
  store().receive(event(2, { type: "question_resolved", requestId: request.id }))
  expect(ready().questions).toStrictEqual([])
  store().receive(event(3, { type: "question_requested", request }))
  expect(ready().questions).toStrictEqual([request])
  store().receive(event(4, { type: "turn_failed", message: "Interrupted" }))
  expect(ready().questions).toStrictEqual([])
})

test("clears pending questions immediately when a turn reaches a usage limit", async () => {
  await loadReady()
  const request = { id: "q-limit", threadId, provider: "codex" as const, questions: [] }
  store().receive(event(1, { type: "question_requested", request }))
  expect(ready().questions).toStrictEqual([request])
  store().receive(event(2, { type: "turn_limited", limit: { kind: "org_spend", message: "Usage exhausted" } }))
  expect(ready().questions).toStrictEqual([])
})

const transcript = (text: string, seq: number) => ({
  result: { messages: [assistant(text)], approvals: [], questions: [], secretRequests: [], seq },
})

const reloadAfterUnload = () => {
  const first = transcriptResponse
  const firstLoad = store().load(threadId)
  store().unload(threadId)
  store().receive(event(1, { type: "text_delta", text: "while unloaded" }))
  expect(store().byThread[threadId]).toBeUndefined()
  transcriptResponse = Promise.withResolvers()
  const second = transcriptResponse
  const secondLoad = store().load(threadId)
  store().receive(event(2, { type: "text_delta", text: " and after reload" }))
  return { first, firstLoad, second, secondLoad }
}

test.each(["older first", "newer first"])(
  "a reload keeps its own snapshot when the request before unload resolves %s",
  async (order) => {
    const { first, firstLoad, second, secondLoad } = reloadAfterUnload()
    if (order === "older first") {
      first.resolve(transcript("stale", 0))
      await firstLoad
      second.resolve(transcript("while unloaded", 1))
    } else {
      second.resolve(transcript("while unloaded", 1))
      await secondLoad
      first.resolve(transcript("stale", 0))
    }
    await Promise.all([firstLoad, secondLoad])

    expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "while unloaded and after reload" }])
  },
)

test("a failed request from before unload cannot fail the reload", async () => {
  const { first, firstLoad, second, secondLoad } = reloadAfterUnload()
  first.resolve({ error: { tag: "ThreadNotFound", message: "stale failure" } })
  await firstLoad
  expect(store().byThread[threadId]?.status).toBe("loading")
  second.resolve(transcript("while unloaded", 1))
  await secondLoad

  expect(ready().messages[0]?.parts).toStrictEqual([{ type: "text", text: "while unloaded and after reload" }])
})
