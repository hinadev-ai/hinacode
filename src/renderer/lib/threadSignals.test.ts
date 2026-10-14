import { afterEach, beforeEach, expect, test } from "@effect/vitest"
import { AtomRegistry } from "effect/reactivity"
import type { Thread } from "../../shared/domain.ts"
import { useThreads } from "../stores/threads.ts"
import { threadSettledSignal, threadStatusSignal } from "./threadSignals.ts"

const thread: Thread = {
  id: "thread",
  projectId: "project",
  worktreeId: null,
  title: "Thread",
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  accessMode: "supervised",
  accountId: null,
  providerSessionId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  createdBy: "user",
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
}

let registry: AtomRegistry.AtomRegistry

beforeEach(() => {
  registry = AtomRegistry.make()
  useThreads.getState().replaceAll([thread])
})

afterEach(() => registry.dispose())

test("status refreshes include turn start, approvals and completion, but exclude metadata updates", () => {
  const signal = threadStatusSignal(thread.id)
  registry.mount(signal)
  expect(registry.get(signal)).toBe(0)

  for (const [index, status] of (["running", "awaiting_approval", "running", "idle"] as const).entries()) {
    useThreads.getState().upsert({ ...thread, status })
    expect(registry.get(signal)).toBe(index + 1)
  }
  useThreads.getState().upsert({ ...thread, title: "Renamed" })
  expect(registry.get(signal)).toBe(4)
})

test("completion refreshes wait until a running or approval turn settles", () => {
  const signal = threadSettledSignal(thread.id)
  registry.mount(signal)
  for (const status of ["running", "awaiting_approval", "running"] as const) {
    useThreads.getState().upsert({ ...thread, status })
    expect(registry.get(signal)).toBe(0)
  }
  useThreads.getState().upsert({ ...thread, status: "limited" })
  expect(registry.get(signal)).toBe(1)
  useThreads.getState().upsert(thread)
  expect(registry.get(signal)).toBe(1)
  useThreads.getState().upsert({ ...thread, status: "awaiting_approval" })
  useThreads.getState().upsert(thread)
  expect(registry.get(signal)).toBe(2)
})

test("thread additions, removals and another thread's turns do not refresh the observed thread", () => {
  useThreads.getState().replaceAll([])
  const signal = threadStatusSignal(thread.id)
  registry.mount(signal)
  useThreads.getState().upsert(thread)
  useThreads.getState().upsert({ ...thread, id: "other", status: "running" })
  expect(registry.get(signal)).toBe(0)
  useThreads.getState().remove(thread.id)
  useThreads.getState().upsert({ ...thread, status: "running" })
  expect(registry.get(signal)).toBe(0)
  useThreads.getState().upsert(thread)
  expect(registry.get(signal)).toBe(1)
})

test("observing another thread starts a separate status history", () => {
  const first = threadStatusSignal(thread.id)
  registry.mount(first)
  useThreads.getState().upsert({ ...thread, status: "running" })
  useThreads.getState().upsert({ ...thread, id: "other" })
  const second = threadStatusSignal("other")
  registry.mount(second)
  useThreads.getState().upsert({ ...thread, id: "other", status: "running" })
  expect(registry.get(first)).toBe(1)
  expect(registry.get(second)).toBe(1)
})

test("mounted status signals notify refresh callbacks without a read or a React render", async () => {
  const seen: Array<number> = []
  const signal = threadStatusSignal(thread.id)
  registry.mount(signal)
  const stop = registry.subscribe(signal, (count) => seen.push(count))
  useThreads.getState().upsert({ ...thread, status: "running" })
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(seen).toStrictEqual([1])
  useThreads.getState().upsert(thread)
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(seen).toStrictEqual([1, 2])
  stop()
})
