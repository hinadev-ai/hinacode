import type { Project, Thread, Worktree } from "@shared/domain.ts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { flush, type PendingCall, thread } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({ call: (await import("./testing")).fakeCall(calls) }))

const { archivedThreads, inboxThreads, matchThreads, pinnedThreads, threadBranch, threadRoot, useThreads } =
  await import("./threads")

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
  useThreads.setState({ projects: [], worktrees: {}, branches: {}, byId: {}, status: "loading", error: null })
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

it("reads everything again when a thread arrives from a project the phone does not know", async () => {
  const first = useThreads.getState().load()
  answer([thread("a", EARLY)])
  await first

  useThreads.getState().upsert({ ...thread("b", LATE), projectId: "added-on-desktop" })
  expect(calls.map((pending) => pending.method)).toEqual(["projects.list", "worktrees.list", "threads.list"])
})

it("keeps a worktree pushed while the worktrees are read", async () => {
  const loading = useThreads.getState().load()
  useThreads.getState().upsertWorktree({ id: "w", path: "/repo-w", status: "ready" } as Worktree)
  answer([thread("a", EARLY)])
  await loading
  expect(useThreads.getState().worktrees["w"]?.path).toBe("/repo-w")
})

describe("lists", () => {
  const at = (minute: number) => `2026-10-16T00:${String(minute).padStart(2, "0")}:00.000Z`
  const row = (id: string, fields: Partial<Thread> = {}) =>
    ({ id, projectId: "p", title: id, status: "idle", pinnedAt: null, updatedAt: at(0), ...fields }) as Thread
  const ids = (threads: readonly Thread[]) => threads.map((existing) => existing.id)

  it("lists the inbox by latest activity, without pinned or archived threads", () => {
    const threads = [
      row("old", { updatedAt: at(1) }),
      row("new", { updatedAt: at(5) }),
      row("waiting", { updatedAt: at(0), status: "awaiting_approval" }),
      row("pinned", { updatedAt: at(9), pinnedAt: at(2) }),
      row("archived", { updatedAt: at(9), status: "archived" }),
    ]
    expect(ids(inboxThreads(threads))).toEqual(["new", "old", "waiting"])
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

describe("threadBranch", () => {
  const worktree = (status: Worktree["status"]) => ({ id: "w", branch: "kk/fix", status }) as Worktree

  it("names the worktree's branch, marked once the worktree is removed", () => {
    expect(threadBranch(worktree("ready"), "main")).toEqual({ name: "kk/fix", removed: false })
    expect(threadBranch(worktree("removed"), "main")).toEqual({ name: "kk/fix", removed: true })
  })

  it("names the project root's branch for a thread without a worktree", () => {
    expect(threadBranch(undefined, "main")).toEqual({ name: "main", removed: false })
  })

  it("names nothing before the branch is read, or for a folder without git", () => {
    expect(threadBranch(undefined, undefined)).toBeNull()
    expect(threadBranch(undefined, "")).toBeNull()
  })
})

it("reads a project root's branch again when one of its threads finishes a turn", async () => {
  const first = useThreads.getState().load()
  calls.find((pending) => pending.method === "projects.list")!.resolve([{ id: "p", name: "p" }])
  calls.find((pending) => pending.method === "worktrees.list")!.resolve([])
  calls.find((pending) => pending.method === "threads.list")!.resolve([
    { ...thread("a", EARLY), projectId: "p", worktreeId: null, status: "running" },
  ])
  await first
  calls.find((pending) => pending.method === "projects.currentBranch")!.resolve("main")
  calls.length = 0
  await flush()

  useThreads.getState().upsert({ ...thread("a", LATE), projectId: "p", worktreeId: null, status: "idle" } as Thread)
  calls.find((pending) => pending.method === "projects.currentBranch")!.resolve("kk/switched")
  await flush()
  expect(useThreads.getState().branches["p"]).toBe("kk/switched")
})
