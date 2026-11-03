import { describe, expect, test } from "@effect/vitest"
import { Result } from "effect"
import type { Thread, Worktree } from "../shared/domain.ts"
import { EXIT } from "./exit.ts"
import { parseThreadRef, resolveThreadRef } from "./threadRef.ts"

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  worktreeId: null,
  title: `title ${id.slice(0, 4)}`,
  provider: "claude",
  model: "m",
  effort: null,
  fastMode: false,
  userSkills: true,
  accessMode: "auto",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  conductor: false,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  ...patch,
})

const worktree = (id: string, path: string): Worktree => ({
  id,
  projectId: "p1",
  path,
  branch: id,
  baseRef: "main",
  status: "ready",
  setupLog: "",
  createdAt: "2026-11-02T00:00:00.000Z",
})

const A = "a41f0c2e-1111-4aaa-8bbb-000000000001"
const B = "a41f9d00-2222-4aaa-8bbb-000000000002"
const C = "c0ffee00-3333-4aaa-8bbb-000000000003"

const threads = [thread(A, { worktreeId: "w1" }), thread(B), thread(C, { worktreeId: "w2" })]
const worktrees = [worktree("w1", "/wt/app/fix-login"), worktree("w2", "/wt/app/fix-login-2")]

const resolved = (raw: string, cwd = "/home") => {
  const ref = parseThreadRef(raw)
  if (Result.isFailure(ref)) return ref
  return Result.map(resolveThreadRef(ref.success, threads, worktrees, cwd), (found) => found.id)
}

const failureOf = (result: Result.Result<unknown, { code: number; message: string }>) => {
  if (Result.isSuccess(result)) throw new Error("expected a failure")
  return result.failure
}

describe("parseThreadRef", () => {
  test("reads . as the thread you stand in, a uuid as an id and hex as a prefix", () => {
    expect(parseThreadRef(".")).toStrictEqual(Result.succeed({ kind: "here" }))
    expect(parseThreadRef(A.toUpperCase())).toStrictEqual(Result.succeed({ kind: "id", id: A }))
    expect(parseThreadRef("A41F")).toStrictEqual(Result.succeed({ kind: "prefix", prefix: "a41f" }))
  })

  test("refuses anything shorter than four hex characters or not hex at all", () => {
    expect(failureOf(parseThreadRef("a41")).code).toBe(EXIT.usage)
    expect(failureOf(parseThreadRef("fix-login")).code).toBe(EXIT.usage)
    expect(failureOf(parseThreadRef("")).code).toBe(EXIT.usage)
  })
})

describe("resolveThreadRef", () => {
  test("finds a thread by id or by a unique prefix", () => {
    expect(resolved(C)).toStrictEqual(Result.succeed(C))
    expect(resolved("a41f0")).toStrictEqual(Result.succeed(A))
  })

  test("lists every match for an ambiguous prefix, as git does", () => {
    const failure = failureOf(resolved("a41f"))
    expect(failure.code).toBe(EXIT.usage)
    expect(failure.message).toBe(
      ["a41f matches more than one thread:", "  a41f0c2e  title a41f", "  a41f9d00  title a41f"].join("\n"),
    )
  })

  test("says when nothing matches", () => {
    expect(failureOf(resolved("beef")).message).toBe("no thread starts with beef")
    expect(failureOf(resolved("beefbeef-0000-4000-8000-000000000000")).code).toBe(EXIT.usage)
  })

  test("resolves . to the thread whose worktree contains the current directory", () => {
    expect(resolved(".", "/wt/app/fix-login")).toStrictEqual(Result.succeed(A))
    expect(resolved(".", "/wt/app/fix-login/src/auth")).toStrictEqual(Result.succeed(A))
    expect(resolved(".", "/wt/app/fix-login-2")).toStrictEqual(Result.succeed(C))
    expect(failureOf(resolved(".", "/wt/app")).message).toBe("no thread works in /wt/app")
  })

  test("skips archived and side threads that share the worktree", () => {
    const shared = [
      thread(A, { worktreeId: "w1" }),
      thread(B, { worktreeId: "w1", sideOf: A }),
      thread(C, { worktreeId: "w1", status: "archived" }),
    ]
    expect(
      Result.map(resolveThreadRef({ kind: "here" }, shared, worktrees, "/wt/app/fix-login"), (found) => found.id),
    ).toStrictEqual(Result.succeed(A))
  })
})
