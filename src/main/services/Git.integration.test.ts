import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Git from "./Git.ts"
import { useHostileDiffConfig } from "./gitTesting.ts"

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim()

const commit = (root: string, file: string, content: string) => {
  writeFileSync(join(root, file), content)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", file)
}

describe("Git.show", () => {
  it.live("pins the patch format against user config and diffs a merge against its first parent", () =>
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "kk-git-show-test-"))),
      (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          execFileSync("git", ["init", "-q", "-b", "main", root])
          commit(root, "base.txt", "same content\n")
          git(root, "switch", "-q", "-c", "feature")
          git(root, "mv", "base.txt", "移動.txt")
          commit(root, "機能.txt", "feature\n")
          git(root, "switch", "-q", "main")
          commit(root, "main.txt", "main\n")
          git(root, "merge", "-q", "--no-ff", "-m", "merge", "feature")
          useHostileDiffConfig(root)

          const diff = yield* (yield* Git.Git).show(root, git(root, "rev-parse", "HEAD"))
          expect(diff.files).toStrictEqual([
            { path: "base.txt", status: "deleted" },
            { path: "機能.txt", status: "added" },
            { path: "移動.txt", status: "added" },
          ])
          expect(diff.patch).toContain("diff --git a/機能.txt b/機能.txt")
          expect(diff.patch).toContain("diff --git a/base.txt b/base.txt")
          expect(diff.patch).not.toContain("main.txt")
          expect(diff.patch).not.toContain("EXTERNAL DIFF")
          expect(diff.patch).not.toContain("\x1b[")
        }),
      ),
      Effect.provide(Git.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  )
})
