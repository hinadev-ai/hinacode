import type { ApprovalRequest, QuestionRequest } from "@shared/agent.ts"
import type { Thread, ThreadStatus } from "@shared/domain.ts"
import { describe, expect, it } from "vitest"
import type { ThreadHistory } from "@/stores/messages"
import { homeSummary, openRequests, stopwatch, threadsWithRequests, waitingThreads } from "./home-summary"

const at = (hour: number, day = 8) => new Date(2026, 10, day, hour, 0).toISOString()
const NOW = Date.parse(at(15))

const thread = (id: string, status: ThreadStatus, updatedAt = at(12)) => ({ id, status, updatedAt }) as Thread
const approval = (id: string) => ({ id }) as ApprovalRequest
const question = (id: string) => ({ id }) as QuestionRequest
const history = (approvals: readonly ApprovalRequest[], questions: readonly QuestionRequest[] = []): ThreadHistory => ({
  status: "ready",
  messages: [],
  hasEarlier: false,
  loadingEarlier: false,
  approvals,
  questions,
})
const ids = (threads: readonly Thread[]) => threads.map((existing) => existing.id)

describe("waitingThreads", () => {
  it("takes threads awaiting approval and threads whose history holds a request, newest first", () => {
    const threads = [
      thread("old", "awaiting_approval", at(9)),
      thread("asks", "running", at(11)),
      thread("new", "awaiting_approval", at(13)),
      thread("busy", "running", at(14)),
    ]
    expect(ids(waitingThreads(threads, threadsWithRequests({ asks: history([], [question("q")]) })))).toEqual(["new", "asks", "old"])
  })

  it("leaves out archived threads, even with a stale request", () => {
    expect(waitingThreads([thread("a", "archived")], "a")).toEqual([])
  })
})

describe("threadsWithRequests", () => {
  it("names the loaded histories that still hold a request, in a stable order", () => {
    const histories = {
      b: history([approval("a")]),
      none: history([]),
      a: history([], [question("q")]),
      loading: { status: "loading", pending: [] } as const,
    }
    expect(threadsWithRequests(histories)).toBe("a b")
  })
})

describe("openRequests", () => {
  it("lists approvals before questions", () => {
    expect(openRequests(history([approval("a")], [question("q")])).map((open) => open.request.id)).toEqual(["a", "q"])
  })

  it("is empty while the history loads", () => {
    expect(openRequests({ status: "loading", pending: [] })).toEqual([])
    expect(openRequests(undefined)).toEqual([])
  })
})

describe("homeSummary", () => {
  it("counts waiting, running and today's finished threads", () => {
    const summary = homeSummary(
      [
        thread("wait", "awaiting_approval"),
        thread("run", "running"),
        thread("ask", "running"),
        thread("done", "idle", at(1)),
        thread("yesterday", "idle", at(23, 7)),
        thread("archived", "archived"),
        thread("draft", "draft"),
        thread("limited", "limited"),
      ],
      "ask",
      NOW,
    )
    expect(ids(summary.waiting)).toEqual(["wait", "ask"])
    expect(ids(summary.running)).toEqual(["run"])
    expect(summary.doneToday).toBe(1)
  })

  it("starts today at the phone's local midnight", () => {
    const summary = homeSummary(
      [thread("midnight", "idle", at(0)), thread("before", "idle", new Date(2026, 10, 7, 23, 59).toISOString())],
      "",
      NOW,
    )
    expect(summary.doneToday).toBe(1)
  })
})

describe("stopwatch", () => {
  it("reads minutes and seconds under an hour", () => {
    expect(stopwatch(0)).toBe("00:00")
    expect(stopwatch(65_400)).toBe("01:05")
    expect(stopwatch(59 * 60_000 + 59_999)).toBe("59:59")
  })

  it("adds hours from the first hour", () => {
    expect(stopwatch(3_600_000)).toBe("1:00:00")
    expect(stopwatch(12 * 3_600_000 + 3 * 60_000 + 7_000)).toBe("12:03:07")
  })

  it("reads zero for a start slightly in the future", () => {
    expect(stopwatch(-4_000)).toBe("00:00")
  })
})
