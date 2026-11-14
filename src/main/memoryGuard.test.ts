import { describe, expect, it } from "vitest"
import {
  heaviestWorthShedding,
  judge,
  memoryByThread,
  type ProcessUsage,
  shedMessage,
  STALL_HOLD_MS,
  STALL_LIMIT_PERCENT,
} from "./memoryGuard.ts"

const MIB = 1024 ** 2
const GIB = 1024 ** 3
const roomy = { stalledPercent: 0, freeBytes: 8 * GIB, capacityBytes: 16 * GIB }
const stalled = { ...roomy, stalledPercent: STALL_LIMIT_PERCENT }

describe("judge", () => {
  it("sheds at once when less than the reserve is free", () => {
    expect(judge(null, { ...roomy, freeBytes: GIB - 1 }, 0)).toStrictEqual({ stalledSince: null, shed: true })
    expect(judge(null, { ...roomy, freeBytes: GIB }, 0)).toStrictEqual({ stalledSince: null, shed: false })
  })

  it("keeps a tenth of a small machine in reserve", () => {
    const small = { stalledPercent: 0, capacityBytes: 4 * GIB }
    expect(judge(null, { ...small, freeBytes: 0.4 * GIB - 1 }, 0).shed).toBe(true)
    expect(judge(null, { ...small, freeBytes: 0.4 * GIB }, 0).shed).toBe(false)
  })

  it("sheds once memory has stalled for the whole hold", () => {
    const started = judge(null, stalled, 1_000)
    expect(started).toStrictEqual({ stalledSince: 1_000, shed: false })
    expect(judge(started.stalledSince, stalled, 1_000 + STALL_HOLD_MS - 1).shed).toBe(false)
    expect(judge(started.stalledSince, stalled, 1_000 + STALL_HOLD_MS)).toStrictEqual({
      stalledSince: 1_000 + STALL_HOLD_MS,
      shed: true,
    })
  })

  it("forgets the stall when it eases below the limit", () => {
    const eased = { ...roomy, stalledPercent: STALL_LIMIT_PERCENT - 0.01 }
    expect(judge(1_000, eased, 1_000 + STALL_HOLD_MS)).toStrictEqual({ stalledSince: null, shed: false })
  })
})

const hinacode = 100
const processes: ReadonlyArray<ProcessUsage> = [
  { pid: hinacode, parent: 1, bytes: 200 * MIB },
  { pid: 200, parent: hinacode, bytes: 300 * MIB },
  { pid: 210, parent: 200, bytes: 1024 * MIB },
  { pid: 211, parent: 210, bytes: 2048 * MIB },
  { pid: 250, parent: hinacode, bytes: 250 * MIB },
  { pid: 251, parent: 250, bytes: 100 * MIB },
  { pid: 300, parent: hinacode, bytes: 300 * MIB },
  { pid: 310, parent: 300, bytes: 500 * MIB },
  { pid: 400, parent: hinacode, bytes: 10 * MIB },
  { pid: 410, parent: 400, bytes: 8192 * MIB },
]
const agents = new Map([
  ["light", new Set([300])],
  ["heavy", new Set([200, 250])],
])

describe("memoryByThread", () => {
  it("adds up each thread's agents and everything under them, heaviest thread and tool first", () => {
    expect(memoryByThread(processes, agents)).toStrictEqual([
      {
        threadId: "heavy",
        bytes: (300 + 1024 + 2048 + 250 + 100) * MIB,
        tools: [
          { pid: 211, parent: 210, bytes: 2048 * MIB },
          { pid: 210, parent: 200, bytes: 1024 * MIB },
          { pid: 251, parent: 250, bytes: 100 * MIB },
        ],
      },
      { threadId: "light", bytes: 800 * MIB, tools: [{ pid: 310, parent: 300, bytes: 500 * MIB }] },
    ])
  })

  it("counts an agent that has exited as nothing", () => {
    expect(memoryByThread(processes, new Map([["gone", new Set([999])]]))).toStrictEqual([
      { threadId: "gone", bytes: 0, tools: [] },
    ])
  })
})

describe("heaviestWorthShedding", () => {
  const threads = memoryByThread(processes, agents)

  it("picks the heaviest thread when the agents hold at least the reserve", () => {
    expect(heaviestWorthShedding(threads, 16 * GIB)?.threadId).toBe("heavy")
  })

  it("stands down when the agents hold less than the reserve", () => {
    expect(heaviestWorthShedding(memoryByThread(processes, new Map([["light", new Set([300])]])), 16 * GIB)).toBe(
      undefined,
    )
    expect(heaviestWorthShedding([], 16 * GIB)).toBe(undefined)
  })
})

describe("shedMessage", () => {
  const [heavy] = memoryByThread(processes, agents)

  it("leads with the reason and names the largest process", () => {
    expect(shedMessage(heavy!, "node node_modules/.bin/vitest run")).toBe(
      "Stopped to free memory. This machine was about to run out, and this thread's processes held the most: 3.6 GB. " +
        "The largest was `node node_modules/.bin/vitest run` at 2.0 GB.",
    )
  })

  it("leaves the process out when the thread had none running or its command is unknown", () => {
    const held = "Stopped to free memory. This machine was about to run out, and this thread's processes held the most"
    expect(shedMessage({ threadId: "idle", bytes: 300 * MIB, tools: [] }, "")).toBe(`${held}: 300 MB.`)
    expect(shedMessage(heavy!, "")).toBe(`${held}: 3.6 GB.`)
  })
})
