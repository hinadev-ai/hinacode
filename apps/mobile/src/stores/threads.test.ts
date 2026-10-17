import type { Project, Thread, Worktree } from "@shared/domain.ts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { flush, type PendingCall, thread } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({ call: (await import("./testing")).fakeCall(calls) }))

const { archivedThreads, inboxThreads, matchThreads, pinnedThreads, threadRoot, useThreads } = await import("./threads")

const EARLY = "2026-10-16T00:00:00.000Z"
const LATE = "2026-10-16T00:01:00.000Z"

function answer(threads: readonly unknown[]) {
  calls.find((pending) => pending.method === "projects.list")!.resolve([])
  calls.find((pending) => pending.method === "worktrees.list")!.resolve([])
  calls.find((pending) => pending.method === "threads.list")!.resolve(threads)
  calls.length = 0
}

const titles = () =>
  Object.fromEntries(Object.values(useThreads.getState().byId).map((existing) => [existing.id, existing.title]))

beforeEach(() => {
  calls.length = 0
  useThreads.setState({ projects: [], worktrees: {}, byId: {}, status: "loading", error: null })
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
  older.find((pending) => pending.method === "worktrees.list")!.resolve([])
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

describe("lists", () => {
  const at = (minute: number) => `2026-10-16T00:${String(minute).padStart(2, "0")}:00.000Z`
  const row = (id: string, fields: Partial<Thread> = {}) =>
    ({ id, projectId: "p", title: id, status: "idle", pinnedAt: null, updatedAt: at(0), ...fields }) as Thread
  const ids = (threads: readonly Thread[]) => threads.map((existing) => existing.id)

  it("puts threads that need a human first in the inbox, then the latest activity", () => {
    const threads = [
      row("old", { updatedAt: at(1) }),
      row("new", { updatedAt: at(5) }),
      row("waiting", { updatedAt: at(0), status: "awaiting_approval" }),
      row("pinned", { updatedAt: at(9), pinnedAt: at(2) }),
      row("archived", { updatedAt: at(9), status: "archived" }),
    ]
    expect(ids(inboxThreads(threads))).toEqual(["waiting", "new", "old"])
    expect(ids(pinnedThreads(threads))).toEqual(["pinned"])
    expect(ids(archivedThreads(threads))).toEqual(["archived"])
  })

  it("keeps pins in the order they were pinned", () => {
    const threads = [row("second", { pinnedAt: at(3) }), row("first", { pinnedAt: at(1) })]
    expect(ids(pinnedThreads(threads))).toEqual(["first", "second"])
  })

  it("matches every word against the title and the project name, archived threads last", () => {
    const projects = [{ id: "p", name: "Hinacode" }, { id: "q", name: "site" }] as unknown as Project[]
    const threads = [
      row("a", { title: "Fix login test", updatedAt: at(1) }),
      row("b", { title: "Login page copy", projectId: "q", updatedAt: at(2) }),
      row("c", { title: "Old login work", status: "archived", updatedAt: at(9) }),
    ]
    expect(ids(matchThreads(threads, projects, "LOGIN"))).toEqual(["b", "a", "c"])
    expect(ids(matchThreads(threads, projects, "login hina"))).toEqual(["a", "c"])
    expect(matchThreads(threads, projects, "  ")).toEqual([])
  })
})

describe("threadRoot", () => {
  const projects = [{ id: "p", rootPath: "/repo" }] as unknown as Project[]
  const worktree = (status: Worktree["status"]) => ({ w: { id: "w", path: "/repo-w", status } as Worktree })
  const inProject = (worktreeId: string | null) => ({ projectId: "p", worktreeId }) as Thread

  it("is the project root without a worktree", () => {
    expect(threadRoot(inProject(null), projects, {})).toBe("/repo")
  })

  it("is the worktree while it exists, and the project root once it is removed", () => {
    expect(threadRoot(inProject("w"), projects, worktree("ready"))).toBe("/repo-w")
    expect(threadRoot(inProject("w"), projects, worktree("removed"))).toBe("/repo")
  })

  it("is unknown until the worktree has loaded", () => {
    expect(threadRoot(inProject("w"), projects, {})).toBeNull()
  })
})
