import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as Git from "./Git.ts"
import { useHostileDiffConfig } from "./gitTesting.ts"
import { diffWorkingTree, snapshotWorkingTree } from "./workingTree.ts"

const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

const withRepo = <A, E>(f: (root: string) => Effect.Effect<A, E, Git.Git | FileSystem.FileSystem>) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "kk-working-tree-test-"))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((root) => {
      execFileSync("git", ["init", "-q", "-b", "main", root])
      return f(root)
    }),
    Effect.provide(Git.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  )

describe("diffWorkingTree", () => {
  it.live("reports edits, deletions and new files since a snapshot, but not ignored ones", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        writeFileSync(join(root, ".gitignore"), "*.log\n")
        writeFileSync(join(root, "kept.txt"), "before\n")
        writeFileSync(join(root, "gone.txt"), "bye\n")
        git(root, "add", "-A")
        git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        writeFileSync(join(root, "staged.txt"), "staged\n")
        git(root, "add", "staged.txt")
        const statusBefore = git(root, "status", "--porcelain")
        const cachedBefore = git(root, "diff", "--cached")

        const base = yield* snapshotWorkingTree(root)
        expect(git(root, "status", "--porcelain")).toBe(statusBefore)
        expect(git(root, "diff", "--cached")).toBe(cachedBefore)

        writeFileSync(join(root, "kept.txt"), "after\n")
        unlinkSync(join(root, "gone.txt"))
        writeFileSync(join(root, "new.txt"), "fresh\n")
        writeFileSync(join(root, "debug.log"), "noise\n")
        const statusAfterEdits = git(root, "status", "--porcelain")

        const changes = yield* diffWorkingTree(root, base)
        expect(changes.files).toStrictEqual([
          { path: "gone.txt", status: "deleted" },
          { path: "kept.txt", status: "modified" },
          { path: "new.txt", status: "added" },
        ])
        expect(changes.patch).toContain("diff --git a/new.txt b/new.txt")
        expect(changes.patch).toContain("+fresh")
        expect(changes.patch).toContain("+after")
        expect(changes.patch).not.toContain("debug.log")
        expect(git(root, "status", "--porcelain")).toBe(statusAfterEdits)
        expect(git(root, "diff", "--cached")).toBe(cachedBefore)
      }),
    ),
  )

  it.live("snapshots a repo that has no commits yet", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        const base = yield* snapshotWorkingTree(root)
        writeFileSync(join(root, "first.txt"), "hello\n")
        const changes = yield* diffWorkingTree(root, base)
        expect(changes.files).toStrictEqual([{ path: "first.txt", status: "added" }])
        expect(git(root, "status", "--porcelain")).toBe("?? first.txt\n")
      }),
    ),
  )

  it.live("pins the patch format against user config, with Unicode paths and staged and new files", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        writeFileSync(join(root, "old.txt"), "same content\n")
        git(root, "add", "-A")
        git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        useHostileDiffConfig(root)
        const base = yield* snapshotWorkingTree(root)

        git(root, "mv", "old.txt", "renamed.txt")
        writeFileSync(join(root, "staged-日本.txt"), "staged\n")
        git(root, "add", "staged-日本.txt")
        writeFileSync(join(root, "新しい.txt"), "untracked\n")

        const changes = yield* diffWorkingTree(root, base)
        expect(changes.files).toStrictEqual([
          { path: "old.txt", status: "deleted" },
          { path: "renamed.txt", status: "added" },
          { path: "staged-日本.txt", status: "added" },
          { path: "新しい.txt", status: "added" },
        ])
        expect(changes.patch).toContain("diff --git a/新しい.txt b/新しい.txt")
        expect(changes.patch).toContain("diff --git a/staged-日本.txt b/staged-日本.txt")
        expect(changes.patch).toContain("diff --git a/old.txt b/old.txt")
        expect(changes.patch).not.toContain("EXTERNAL DIFF")
        expect(changes.patch).not.toContain("\x1b[")
      }),
    ),
  )
})
