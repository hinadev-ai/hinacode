import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer } from "effect"
import * as Git from "./Git.ts"
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

const commitAll = (root: string) => {
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "commit")
}

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

        const changes = yield* diffWorkingTree(root, Effect.succeed(base))
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
        const changes = yield* diffWorkingTree(root, Effect.succeed(base))
        expect(changes.files).toStrictEqual([{ path: "first.txt", status: "added" }])
        expect(git(root, "status", "--porcelain")).toBe("?? first.txt\n")
      }),
    ),
  )

  it.live("lists the same files and patch as separate name-status and patch diffs", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        writeFileSync(join(root, "kept.txt"), "before\n")
        writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2]))
        commitAll(root)
        const base = yield* snapshotWorkingTree(root)
        writeFileSync(join(root, "kept.txt"), "after\n")
        unlinkSync(join(root, "image.bin"))
        writeFileSync(join(root, "tab\tname.txt"), "tab\n")
        writeFileSync(join(root, "日本語.txt"), "kana\n")

        const changes = yield* diffWorkingTree(root, Effect.succeed(base))
        const tree = yield* snapshotWorkingTree(root)
        const diff = (...args: Array<string>) =>
          git(
            root,
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-renames",
            "--no-color",
            "--no-ext-diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            ...args,
            base,
            tree,
          )
        expect(changes.files).toStrictEqual(Git.parseNameStatus(diff("--name-status", "-z")))
        expect(changes.files.map((file) => file.path)).toStrictEqual([
          "image.bin",
          "kept.txt",
          "tab\tname.txt",
          "日本語.txt",
        ])
        expect(changes.patch).toBe(diff())
      }),
    ),
  )

  it.live("never hands a request a snapshot that started before it", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        writeFileSync(join(root, "kept.txt"), "before\n")
        commitAll(root)
        const base = yield* snapshotWorkingTree(root)
        const started = join(root, ".git", "snapshot-started")
        git(root, "config", "filter.slow.clean", `touch '${started}'; sleep 1; cat`)
        writeFileSync(join(root, ".git", "info", "attributes"), "kept.txt filter=slow\n")
        writeFileSync(join(root, "kept.txt"), "during\n")

        const first = yield* Effect.forkChild(diffWorkingTree(root, Effect.succeed(base)))
        yield* Effect.gen(function* () {
          while (!existsSync(started)) yield* Effect.sleep("10 millis")
        }).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.die(new Error("the slow clean filter never ran, so the two diffs never overlapped")),
          }),
        )
        writeFileSync(join(root, "late.txt"), "late\n")
        const second = yield* diffWorkingTree(root, Effect.succeed(base))
        yield* Fiber.join(first)

        expect(second.files.map((file) => file.path)).toContain("late.txt")
      }),
    ),
  )
})
