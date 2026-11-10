import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { HinacodeBridge } from "../../shared/contract.ts"
import { fileSearchSource, threadSearchSource } from "./search.tsx"
import type { PaletteContext } from "./types.ts"

const searched: Array<unknown> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "search.threads" || method === "search.files") {
      searched.push(payload)
      return { result: [] }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const ctx = { threads: {}, threadId: "thread-1" } as unknown as PaletteContext

beforeEach(() => {
  threadSearchSource.items("", ctx)
  fileSearchSource.items("", ctx)
  searched.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test("typing a word searches threads once, for the whole word", async () => {
  const results = ["a", "ag", "age", "agen", "agent"].map((query) => threadSearchSource.items(query, ctx))
  await vi.advanceTimersByTimeAsync(150)

  await expect(Promise.all(results)).resolves.toStrictEqual([[], [], [], [], []])
  expect(searched).toStrictEqual([{ query: "agent" }])
})

test("a query typed after a pause searches again", async () => {
  const first = threadSearchSource.items("agent", ctx)
  await vi.advanceTimersByTimeAsync(150)
  await first
  const second = threadSearchSource.items("agents", ctx)
  await vi.advanceTimersByTimeAsync(150)
  await second

  expect(searched).toStrictEqual([{ query: "agent" }, { query: "agents" }])
})

test("rendering again with the same query keeps the settled results without searching again", async () => {
  const first = threadSearchSource.items("agent", ctx)
  await vi.advanceTimersByTimeAsync(150)
  await first
  const second = threadSearchSource.items("agent", ctx)

  expect(second).toBe(first)
  expect(searched).toStrictEqual([{ query: "agent" }])
})

test("rendering again with the same query keeps the settled file results without searching again", async () => {
  const first = fileSearchSource.items("agent", ctx)
  await vi.advanceTimersByTimeAsync(150)
  await first
  const second = fileSearchSource.items("agent", ctx)

  expect(second).toBe(first)
  expect(searched).toStrictEqual([{ threadId: "thread-1", query: "agent" }])
})
