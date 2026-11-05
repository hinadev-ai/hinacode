import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { HinacodeBridge } from "../../shared/contract.ts"
import { threadSearchSource } from "./search.tsx"
import type { PaletteContext } from "./types.ts"

const searched: Array<unknown> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "search.threads") {
      searched.push(payload)
      return { result: [] }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
}
Object.defineProperty(window, "hinacode", { value: bridge })

const ctx = { threads: {} } as unknown as PaletteContext

beforeEach(() => {
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
