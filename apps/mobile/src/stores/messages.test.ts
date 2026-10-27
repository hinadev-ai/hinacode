import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Message } from "@shared/domain.ts"
import { flush, message, type PendingCall } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({ call: (await import("./testing")).fakeCall(calls) }))

const { useMessages } = await import("./messages")

const snapshot = (seq: number, ids: readonly string[]) => ({
  seq,
  messages: ids.map((id) => message(id)),
  approvals: [],
  questions: [],
})
const created = (seq: number, id: string) => ({ type: "message.created" as const, seq, message: message(id) })
const history = () => useMessages.getState().byThread.t1
const ids = () => {
  const current = history()
  return current?.status === "ready" ? current.messages.map((existing) => existing.id) : current?.status
}

const assistant = (id: string): Message => ({ ...message(id), role: "assistant" })
const tool = (status: "running" | "done" | "error") =>
  ({ type: "tool_call", callId: "tool", name: "Bash", input: {}, status }) as const
const finished = (seq: number, output: string) => ({
  type: "thread.event" as const,
  threadId: "t1",
  seq,
  event: { type: "tool_call_finished" as const, callId: "tool", output, isError: false },
})
const toolStatus = (id: string) => {
  const current = history()
  const part = current?.status === "ready" ? current.messages.find((existing) => existing.id === id)?.parts[0] : undefined
  return part?.type === "tool_call" ? part.status : undefined
}

async function loadReadyPage(seq: number, messages: readonly Message[], hasEarlier: boolean) {
  const loading = useMessages.getState().load("t1")
  calls.shift()!.resolve({ ...snapshot(seq, []), messages, hasEarlier })
  await loading
}

async function loadReady(seq: number, messageIds: readonly string[]) {
  const loading = useMessages.getState().load("t1")
  calls.shift()!.resolve(snapshot(seq, messageIds))
  await loading
}

beforeEach(() => {
  calls.length = 0
  useMessages.getState().reset()
})

describe("load", () => {
  it("applies pushes that arrive before the snapshot only when they are newer", async () => {
    const loading = useMessages.getState().load("t1")
    useMessages.getState().receive(created(4, "old"))
    useMessages.getState().receive(created(6, "new"))
    calls.shift()!.resolve(snapshot(5, ["old"]))
    await loading
    expect(ids()).toEqual(["old", "new"])
  })

  it("does not let a snapshot from before a reset settle a newer load", async () => {
    void useMessages.getState().load("t1")
    const previousDesktop = calls.shift()!
    useMessages.getState().reset()
    void useMessages.getState().load("t1")
    const current = calls.shift()!

    previousDesktop.resolve(snapshot(100, ["stale"]))
    await flush()
    expect(history()?.status).toBe("loading")

    current.resolve(snapshot(1, ["fresh"]))
    await flush()
    expect(ids()).toEqual(["fresh"])
  })

  it("does not let a failure from before a reset settle a newer load", async () => {
    void useMessages.getState().load("t1")
    const previousDesktop = calls.shift()!
    useMessages.getState().reset()
    void useMessages.getState().load("t1")

    previousDesktop.reject(new Error("closed"))
    await flush()
    expect(history()?.status).toBe("loading")
  })
})

describe("reload", () => {
  it("keeps the last known history on screen until the new snapshot swaps in", async () => {
    await loadReady(1, ["a"])
    const before = history()
    useMessages.getState().reload()
    expect(calls.map((pending) => pending.method)).toEqual(["threads.transcript"])
    expect(history()).toBe(before)

    calls.shift()!.resolve(snapshot(3, ["a", "b", "c"]))
    await flush()
    expect(ids()).toEqual(["a", "b", "c"])
  })

  it("shows pushes during the reload and replays only those newer than the snapshot", async () => {
    await loadReady(1, ["a"])
    useMessages.getState().reload()
    useMessages.getState().receive(created(2, "b"))
    useMessages.getState().receive(created(3, "c"))
    expect(ids()).toEqual(["a", "b", "c"])

    calls.shift()!.resolve(snapshot(2, ["a", "b"]))
    await flush()
    expect(ids()).toEqual(["a", "b", "c"])
  })

  it("keeps the history when the reload fails", async () => {
    await loadReady(1, ["a"])
    useMessages.getState().reload()
    calls.shift()!.reject(new Error("Timeout"))
    await flush()
    expect(ids()).toEqual(["a"])
  })

  it("ignores an older reload answered after a newer one started", async () => {
    await loadReady(1, ["a"])
    useMessages.getState().reload()
    const older = calls.shift()!
    useMessages.getState().reload()
    const newer = calls.shift()!

    newer.resolve(snapshot(5, ["a", "b"]))
    await flush()
    older.resolve(snapshot(2, ["a"]))
    await flush()
    expect(ids()).toEqual(["a", "b"])
  })

  it("does not let a reload from before a reset settle the next desktop's history", async () => {
    await loadReady(1, ["a"])
    useMessages.getState().reload()
    const previousDesktop = calls.shift()!
    useMessages.getState().reset()
    await loadReady(1, ["x"])

    previousDesktop.resolve(snapshot(9, ["stale"]))
    await flush()
    expect(ids()).toEqual(["x"])
  })

  it("loads again a history whose first load failed, and leaves one still loading to its own call", async () => {
    const failing = useMessages.getState().load("t1")
    calls.shift()!.reject(new Error("offline"))
    await failing
    void useMessages.getState().load("t2")
    calls.length = 0

    useMessages.getState().reload()
    expect(calls.map((pending) => pending.payload)).toEqual([{ threadId: "t1", compact: true, page: {} }])
  })
})

describe("earlier pages", () => {
  const page = (ids: readonly string[], hasEarlier: boolean) => ({ ...snapshot(1, ids), hasEarlier })

  it("asks for the newest page, then prepends the page before the oldest message", async () => {
    const loading = useMessages.getState().load("t1")
    const first = calls.shift()!
    expect(first.payload).toEqual({ threadId: "t1", compact: true, page: {} })
    first.resolve(page(["c", "d"], true))
    await loading

    const earlier = useMessages.getState().loadEarlier("t1")
    const call = calls.shift()!
    expect(call.payload).toEqual({ threadId: "t1", compact: true, page: { before: "c" } })
    void useMessages.getState().loadEarlier("t1")
    expect(calls).toHaveLength(0)
    call.resolve(page(["a", "b"], false))
    await earlier
    expect(ids()).toEqual(["a", "b", "c", "d"])

    void useMessages.getState().loadEarlier("t1")
    expect(calls).toHaveLength(0)
  })

  it("treats a server that sends every message as having nothing earlier", async () => {
    await loadReady(1, ["a", "b"])
    void useMessages.getState().loadEarlier("t1")
    expect(calls).toHaveLength(0)
  })

  it("drops the earlier pages when a reload reads the newest page again", async () => {
    const loading = useMessages.getState().load("t1")
    calls.shift()!.resolve(page(["c", "d"], true))
    await loading
    const earlier = useMessages.getState().loadEarlier("t1")
    calls.shift()!.resolve(page(["a", "b"], false))
    await earlier

    useMessages.getState().reload()
    calls.shift()!.resolve(page(["d", "e"], true))
    await flush()
    expect(ids()).toEqual(["d", "e"])
    const current = history()
    expect(current?.status === "ready" && current.hasEarlier).toBe(true)
  })

  it("recovers a tool that finished while offline in a message before the reloaded newest page", async () => {
    await loadReadyPage(1, [{ ...assistant("a"), parts: [tool("running")] }, message("b")], false)
    useMessages.getState().reload()
    calls.shift()!.resolve({ ...snapshot(5, ["b", "c"]), hasEarlier: true })
    await flush()
    expect(ids()).toEqual(["b", "c"])

    const earlier = useMessages.getState().loadEarlier("t1")
    calls.shift()!.resolve({ ...snapshot(5, []), messages: [{ ...assistant("a"), parts: [tool("done")] }], hasEarlier: false })
    await earlier
    expect(toolStatus("a")).toBe("done")
  })

  it("replays a tool result that arrives while an earlier page is read", async () => {
    await loadReadyPage(1, [message("b")], true)
    const earlier = useMessages.getState().loadEarlier("t1")
    const request = calls.shift()!
    useMessages.getState().receive(finished(3, "done"))
    request.resolve({ ...snapshot(2, []), messages: [{ ...assistant("a"), parts: [tool("running")] }], hasEarlier: false })
    await earlier
    expect(toolStatus("a")).toBe("done")
  })

  it("replays only the pushes newer than the earlier page, and none onto the newer messages", async () => {
    await loadReadyPage(1, [message("b")], true)
    const earlier = useMessages.getState().loadEarlier("t1")
    const request = calls.shift()!
    useMessages.getState().receive(finished(2, "failed"))
    useMessages.getState().receive(created(4, "c"))
    request.resolve({ ...snapshot(3, []), messages: [{ ...assistant("a"), parts: [tool("done")] }], hasEarlier: false })
    await earlier
    expect(ids()).toEqual(["a", "b", "c"])
    expect(toolStatus("a")).toBe("done")
  })

  it("ignores an earlier page asked for before a reset", async () => {
    await loadReadyPage(1, [message("b")], true)
    void useMessages.getState().loadEarlier("t1")
    const previousDesktop = calls.shift()!
    useMessages.getState().reset()
    await loadReadyPage(1, [message("b")], true)

    previousDesktop.resolve({ ...snapshot(1, ["stale"]), hasEarlier: false })
    await flush()
    expect(ids()).toEqual(["b"])
    void useMessages.getState().loadEarlier("t1")
    expect(calls).toHaveLength(1)
  })

  it("drops an earlier page that a reload overtook, and can ask again", async () => {
    await loadReadyPage(1, [message("c")], true)
    void useMessages.getState().loadEarlier("t1")
    const overtaken = calls.shift()!
    useMessages.getState().reload()
    calls.shift()!.resolve({ ...snapshot(5, ["d"]), hasEarlier: true })
    await flush()

    overtaken.resolve({ ...snapshot(2, ["a", "b"]), hasEarlier: false })
    await flush()
    expect(ids()).toEqual(["d"])
    void useMessages.getState().loadEarlier("t1")
    expect(calls.map((pending) => pending.payload)).toEqual([{ threadId: "t1", compact: true, page: { before: "d" } }])
  })

  it("can ask again after an earlier page fails", async () => {
    await loadReadyPage(1, [message("b")], true)
    const failing = useMessages.getState().loadEarlier("t1")
    calls.shift()!.reject(new Error("Timeout"))
    await failing
    void useMessages.getState().loadEarlier("t1")
    expect(calls).toHaveLength(1)
  })
})
