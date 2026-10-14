import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { useHostileDiffConfig } from "../services/gitTesting.ts"
import { reviewChanges } from "./reviewChanges.ts"

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim()

describe("reviewChanges", () => {
  it.live("pins the diff format against user config and keeps git's quoting of non-ASCII paths", () =>
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "kk-review-changes-test-"))),
      (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          execFileSync("git", ["init", "-q", "-b", "main", root])
          writeFileSync(join(root, "base.txt"), "base\n")
          git(root, "add", "-A")
          git(root, "commit", "-q", "-m", "init")
          git(root, "switch", "-q", "-c", "kk/review")
          writeFileSync(join(root, "committed.txt"), "committed\n")
          git(root, "add", "-A")
          git(root, "commit", "-q", "-m", "work")
          writeFileSync(join(root, "日本.txt"), "staged\n")
          git(root, "add", "日本.txt")
          writeFileSync(join(root, "base.txt"), "edited\n")
          useHostileDiffConfig(root)

          const report = yield* reviewChanges({ cwd: root, baseRef: "main" })
          const [, againstHead = "", againstBase = ""] = report.split(/^## Diff against /m)
          expect(againstHead).toContain("diff --git a/base.txt b/base.txt")
          expect(againstHead).toContain('diff --git "a/\\346\\227\\245\\346\\234\\254.txt"')
          expect(againstHead).not.toContain("committed.txt")
          expect(againstBase).toContain("diff --git a/committed.txt b/committed.txt")
          expect(report).not.toContain("EXTERNAL DIFF")
          expect(report).not.toContain("\x1b[")
        }),
      ),
    ),
  )
})
