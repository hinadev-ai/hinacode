import { describe, expect, test } from "@effect/vitest"
import { Result } from "effect"
import type { Project, Worktree } from "../shared/domain.ts"
import { resolveProject } from "./projectRef.ts"

const project = (id: string, rootPath: string): Project => ({
  id,
  name: id,
  rootPath,
  setupScript: null,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  linearReview: false,
  kind: "folder",
  actions: [],
})

const projects = [project("app", "/code/app"), project("app-docs", "/code/app/docs")]
const worktrees: ReadonlyArray<Worktree> = [
  {
    id: "w1",
    projectId: "app",
    path: "/wt/app/fix-login",
    branch: "fix-login",
    baseRef: "main",
    status: "ready",
    setupLog: "",
    createdAt: "2026-11-02T00:00:00.000Z",
  },
]

const idOf = (raw: string, cwd: string) =>
  Result.map(resolveProject(raw, projects, worktrees, cwd), (found) => found.id)

describe("resolveProject", () => {
  test("takes an id, a path, or . for the current directory", () => {
    expect(idOf("app-docs", "/")).toStrictEqual(Result.succeed("app-docs"))
    expect(idOf("/code/app/src", "/")).toStrictEqual(Result.succeed("app"))
    expect(idOf(".", "/code/app/docs/guide")).toStrictEqual(Result.succeed("app-docs"))
  })

  test("finds the project of the worktree you stand in", () => {
    expect(idOf(".", "/wt/app/fix-login/src")).toStrictEqual(Result.succeed("app"))
  })

  test("refuses a directory outside every project", () => {
    expect(Result.isFailure(resolveProject(".", projects, worktrees, "/tmp"))).toBe(true)
  })
})
