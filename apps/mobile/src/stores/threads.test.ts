import { beforeEach, expect, it, vi } from "vitest"
import { flush, type PendingCall, thread } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({ call: (await import("./testing")).fakeCall(calls) }))

const { useThreads } = await import("./threads")

const EARLY = "2026-10-16T00:00:00.000Z"
const LATE = "2026-10-16T00:01:00.000Z"

/** Answers the `projects.list` and `threads.list` calls of one `load`. */
function answer(threads: readonly unknown[]) {
  calls.find((pending) => pending.method === "projects.list")!.resolve([])
  calls.find((pending) => pending.method === "threads.list")!.resolve(threads)
  calls.length = 0
}

const titles = () =>
  Object.fromEntries(Object.values(useThreads.getState().byId).map((existing) => [existing.id, existing.title]))

beforeEach(() => {
  calls.length = 0
  useThreads.setState({ projects: [], byId: {}, status: "loading", error: null })
})

it("keeps a thread pushed during the load when it is newer than the listed copy", async () => {
  const loading = useThreads.getState().load()
  useThreads.getState().upsert(thread("a", LATE, "pushed"))
  answer([thread("a", EARLY, "listed"), thread("b", EARLY)])
  await loading
  expect(titles()).toEqual({ a: "pushed", b: "b" })
  expect(useThreads.getState().status).toBe("ready")
})

it("keeps the listed copy when it is newer than the push", async () => {
  const loading = useThreads.getState().load()
  useThreads.getState().upsert(thread("a", EARLY, "pushed"))
  answer([thread("a", LATE, "listed")])
  await loading
  expect(titles()).toEqual({ a: "listed" })
})

it("keeps a thread created during the load that the list predates", async () => {
  const loading = useThreads.getState().load()
  useThreads.getState().upsert(thread("new", LATE))
  answer([thread("a", EARLY)])
  await loading
  expect(titles()).toEqual({ a: "a", new: "new" })
})

it("does not bring back a thread removed during the load", async () => {
  const loading = useThreads.getState().load()
  useThreads.getState().remove("gone")
  answer([thread("a", EARLY), thread("gone", EARLY)])
  await loading
  expect(titles()).toEqual({ a: "a" })
})

it("forgets pushes once the load settles", async () => {
  const first = useThreads.getState().load()
  useThreads.getState().remove("a")
  answer([])
  await first

  const second = useThreads.getState().load()
  answer([thread("a", EARLY)])
  await second
  expect(titles()).toEqual({ a: "a" })
})

it("ignores a load answered after a newer one started", async () => {
  void useThreads.getState().load()
  const older = [...calls]
  calls.length = 0
  const newer = useThreads.getState().load()
  answer([thread("a", LATE, "newer")])
  await newer

  older.find((pending) => pending.method === "projects.list")!.resolve([])
  older.find((pending) => pending.method === "threads.list")!.resolve([thread("a", EARLY, "older")])
  await flush()
  expect(titles()).toEqual({ a: "newer" })
})

it("keeps the threads on screen when a reload fails", async () => {
  const first = useThreads.getState().load()
  answer([thread("a", EARLY)])
  await first

  const failing = useThreads.getState().load()
  calls.find((pending) => pending.method === "threads.list")!.reject(new Error("Timeout"))
  await failing
  expect(titles()).toEqual({ a: "a" })
  expect(useThreads.getState()).toMatchObject({ status: "error", error: "Timeout" })
})
