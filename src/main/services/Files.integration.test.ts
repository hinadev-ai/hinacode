import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option, Queue } from "effect"
import { SqlClient } from "effect/sql"
import type { PushEvent } from "../../shared/contract.ts"
import type { FsEntry } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread, type SeedThread } from "../db/testing.ts"
import { Events } from "./Events.ts"
import { Files, MAX_READ_BYTES } from "./Files.ts"
import * as FilesLayer from "./Files.ts"
import * as Git from "./Git.ts"

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" })

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

let dir = ""
let repo = ""
let worktree = ""
let outside = ""

/**
 * A repo with every kind of entry the tree shows: tracked, modified, untracked (alone and as a whole
 * folder), ignored files and folders, symlinks in and out of the root, and a worktree with a commit.
 */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kk-files-test-"))
  repo = join(dir, "repo")
  worktree = join(dir, "wt")
  outside = join(dir, "outside")
  mkdirSync(outside)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  write(join(repo, ".gitignore"), "node_modules/\n*.log\n")
  for (const name of ["README.md", "Zeta.txt", "alpha.txt", "file10.txt", "file9.txt", "src/a.ts", "src/b.ts"]) {
    write(join(repo, name), `${name}\n`)
  }
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree, "main")
  appendFileSync(join(worktree, "src/b.ts"), "committed\n")
  git(worktree, "commit", "-qam", "work")

  appendFileSync(join(repo, "src/a.ts"), "edit\n")
  write(join(repo, "src/new.ts"), "new\n")
  write(join(repo, "untracked/deep/u.txt"), "u\n")
  write(join(repo, "node_modules/pkg/index.js"), "x\n")
  write(join(repo, "debug.log"), "log\n")
  symlinkSync(outside, join(repo, "escape"))
  symlinkSync(join(repo, "src"), join(repo, "inner"))

  write(join(outside, "secret.txt"), "secret\n")
  symlinkSync(join(outside, "secret.txt"), join(repo, "untracked/leak.txt"))
  write(join(repo, "untracked/huge.txt"), "x".repeat(MAX_READ_BYTES + 10))
  writeFileSync(join(repo, "untracked/image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = <A, E>(
  effect: Effect.Effect<A, E, Files | SqlClient.SqlClient>,
  seed: SeedThread = { rootPath: repo, worktree: { path: worktree, baseRef: "main", status: "ready" } },
  pushes?: Queue.Queue<PushEvent>,
) => {
  const events = Events.of({
    publish: (event) => (pushes ? Queue.offer(pushes, event).pipe(Effect.asVoid) : Effect.void),
  })
  return Effect.gen(function* () {
    yield* seedThread(seed)
    return yield* Files.use(() => effect)
  }).pipe(
    Effect.provide(
      // Each run supplies its own event sink, so it must not reuse an earlier Files service.
      Layer.fresh(FilesLayer.layer).pipe(
        Layer.provide(Layer.mergeAll(Git.layer, Layer.succeed(Events, events))),
        Layer.provideMerge(Db.layer(":memory:")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  )
}

const list = (root: string, path: string) => Files.use((files) => files.list(root, path))

const byName = (entries: ReadonlyArray<FsEntry>) => Object.fromEntries(entries.map((entry) => [entry.name, entry]))

describe("fs.list", () => {
  it.effect("lists one level, folders first, case-insensitive and in natural order, without .git", () =>
    Effect.gen(function* () {
      const entries = yield* run(list(repo, ""))
      expect(entries.map((entry) => entry.name)).toStrictEqual([
        "node_modules",
        "src",
        "untracked",
        ".gitignore",
        "alpha.txt",
        "debug.log",
        "escape",
        "file9.txt",
        "file10.txt",
        "inner",
        "README.md",
        "Zeta.txt",
      ])
      const named = byName(entries)
      expect(named["escape"]?.kind).toBe("symlink")
      expect(named["src"]).toMatchObject({ path: "src", kind: "dir" })
    }),
  )

  it.effect("marks ignored entries, and everything inside an ignored folder", () =>
    Effect.gen(function* () {
      const named = byName(yield* run(list(repo, "")))
      expect(named["node_modules"]?.ignored).toBe(true)
      expect(named["debug.log"]?.ignored).toBe(true)
      expect(named["src"]?.ignored).toBe(false)
      const inside = yield* run(list(repo, "node_modules/pkg"))
      expect(inside).toMatchObject([{ path: "node_modules/pkg/index.js", ignored: true }])
    }),
  )

  it.effect("gives files their git status and folders the status of what changed under them", () =>
    Effect.gen(function* () {
      const root = byName(yield* run(list(repo, "")))
      expect(root["src"]?.gitStatus).toBe("modified")
      expect(root["untracked"]?.gitStatus).toBe("untracked")
      expect(root["README.md"]?.gitStatus).toBe(null)
      const src = byName(yield* run(list(repo, "src")))
      expect(src["a.ts"]).toMatchObject({ path: "src/a.ts", gitStatus: "modified" })
      expect(src["new.ts"]?.gitStatus).toBe("untracked")
      expect(src["b.ts"]?.gitStatus).toBe(null)
      const deep = yield* run(list(repo, "untracked/deep"))
      expect(deep).toMatchObject([{ name: "u.txt", gitStatus: "untracked" }])
    }),
  )

  it.effect("shows what a worktree committed since its base, like the Changes list", () =>
    Effect.gen(function* () {
      const src = byName(yield* run(list(worktree, "src")))
      expect(src["b.ts"]?.gitStatus).toBe("modified")
      expect(src["a.ts"]?.gitStatus).toBe(null)
      expect(byName(yield* run(list(worktree, "")))["src"]?.gitStatus).toBe("modified")
    }),
  )

  it.effect("lists a symlink to a folder inside the root", () =>
    Effect.gen(function* () {
      const entries = yield* run(list(repo, "inner"))
      expect(entries.map((entry) => entry.path)).toContain("inner/a.ts")
    }),
  )

  const refusals: ReadonlyArray<[string, () => [root: string, path: string], string]> = [
    ["a root that is no project or worktree", () => [outside, ""], "unknownRoot"],
    ["a subfolder of a root given as the root", () => [join(repo, "src"), ""], "unknownRoot"],
    ["an absolute path", () => [repo, outside], "outsideRoot"],
    ["a path through ..", () => [repo, "src/../.."], "outsideRoot"],
    ["a symlink that leads out of the root", () => [repo, "escape"], "outsideRoot"],
    ["a folder that does not exist", () => [repo, "missing"], "unreadable"],
    ["a file instead of a folder", () => [repo, "README.md"], "unreadable"],
  ]
  for (const [name, args, reason] of refusals) {
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* run(list(...args())).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FsAccessError", reason })
      }),
    )
  }

  it.effect("refuses a worktree once it is removed", () =>
    Effect.gen(function* () {
      const seed = { rootPath: repo, worktree: { path: worktree, baseRef: "main", status: "removed" as const } }
      const error = yield* run(list(worktree, ""), seed).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FsAccessError", reason: "unknownRoot" })
    }),
  )

  it.effect("lists a chat's own folder, but no other folder in the chats root", () =>
    Effect.gen(function* () {
      const chats = join(dir, "chats")
      const listChat = Effect.gen(function* () {
        const { threadId } = yield* seedThread({ rootPath: chats, kind: "chats" })
        write(join(chats, threadId, "notes.md"), "draft\n")
        write(join(chats, "stray", "notes.md"), "draft\n")
        const own = yield* list(join(chats, threadId), "")
        const stray = yield* list(join(chats, "stray"), "").pipe(Effect.flip)
        return { own, stray }
      })
      const { own, stray } = yield* run(listChat)
      expect(own.map((entry) => entry.path)).toStrictEqual(["notes.md"])
      expect(stray).toMatchObject({ _tag: "FsAccessError", reason: "unknownRoot" })
    }),
  )
})

const read = (root: string, path: string) => run(Files.use((files) => files.read(root, path)))

describe("fs.read", () => {
  it.effect("reads a text file, through a symlink that stays inside the root", () =>
    Effect.gen(function* () {
      expect(yield* read(repo, "src/a.ts")).toStrictEqual({
        content: "src/a.ts\nedit\n",
        truncated: false,
        binary: false,
      })
      expect((yield* read(repo, "inner/b.ts")).content).toBe("src/b.ts\n")
    }),
  )

  it.effect("stops at 1 MB and says so", () =>
    Effect.gen(function* () {
      const huge = yield* read(repo, "untracked/huge.txt")
      expect(huge.truncated).toBe(true)
      expect(huge.content).toHaveLength(MAX_READ_BYTES)
    }),
  )

  it.effect("does not send the bytes of a binary file", () =>
    Effect.gen(function* () {
      expect(yield* read(repo, "untracked/image.bin")).toStrictEqual({ content: "", truncated: false, binary: true })
    }),
  )

  const refusals: ReadonlyArray<[string, () => [root: string, path: string], string]> = [
    ["a root that is no project or worktree", () => [outside, "secret.txt"], "unknownRoot"],
    ["a path through ..", () => [repo, "../outside/secret.txt"], "outsideRoot"],
    ["an absolute path", () => [repo, join(outside, "secret.txt")], "outsideRoot"],
    ["a symlink to a file outside the root", () => [repo, "untracked/leak.txt"], "outsideRoot"],
    ["a folder", () => [repo, "src"], "unreadable"],
    ["a file that does not exist", () => [repo, "missing.txt"], "unreadable"],
  ]
  for (const [name, args, reason] of refusals) {
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* read(...args()).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FsAccessError", reason })
      }),
    )
  }
})

const save = (root: string, path: string, content: string, expected: string | null) =>
  run(Files.use((files) => files.write(root, path, content, expected)))

/** A fresh file per test, so no test sees what another one saved. */
const editable = (name: string, text = "before\n") => {
  const path = `untracked/edits/${name}`
  write(join(repo, path), text)
  return path
}

describe("fs.write", () => {
  it.effect("replaces the text of a file", () =>
    Effect.gen(function* () {
      const path = editable("replace.txt")
      yield* save(repo, path, "after\n", null)
      expect(readFileSync(join(repo, path), "utf8")).toBe("after\n")
    }),
  )

  it.effect("writes when the file still holds the text the edit started from", () =>
    Effect.gen(function* () {
      const path = editable("expected.txt")
      yield* save(repo, path, "after\n", "before\n")
      expect(readFileSync(join(repo, path), "utf8")).toBe("after\n")
    }),
  )

  it.effect("refuses to save over a change made on disk since the edit began, and leaves it alone", () =>
    Effect.gen(function* () {
      const path = editable("stale.txt", "changed by the agent\n")
      const error = yield* save(repo, path, "after\n", "before\n").pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FsWriteConflict", root: repo, path })
      expect(readFileSync(join(repo, path), "utf8")).toBe("changed by the agent\n")
    }),
  )

  it.effect("overwrites whatever is there when no starting text is given", () =>
    Effect.gen(function* () {
      const path = editable("overwrite.txt", "changed by the agent\n")
      yield* save(repo, path, "after\n", null)
      expect(readFileSync(join(repo, path), "utf8")).toBe("after\n")
    }),
  )

  const refusals: ReadonlyArray<[string, () => [root: string, path: string], string]> = [
    ["a root that is no project or worktree", () => [outside, "secret.txt"], "unknownRoot"],
    ["a path through ..", () => [repo, "../outside/secret.txt"], "outsideRoot"],
    ["an absolute path", () => [repo, join(outside, "secret.txt")], "outsideRoot"],
    ["a symlink to a file outside the root", () => [repo, "untracked/leak.txt"], "outsideRoot"],
    ["a folder", () => [repo, "src"], "unwritable"],
  ]
  for (const [name, args, reason] of refusals) {
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* save(...args(), "overwritten\n", null).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FsAccessError", reason })
        expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret\n")
      }),
    )
  }

  it.effect("refuses a file that does not exist, and does not create it", () =>
    Effect.gen(function* () {
      const error = yield* save(repo, "untracked/edits/missing.txt", "new\n", null).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FsAccessError", reason: "unreadable" })
      expect(existsSync(join(repo, "untracked/edits/missing.txt"))).toBe(false)
    }),
  )
})

describe("fs.watch", () => {
  it.live("pushes fs.changed for a watched folder, once per burst", () =>
    Effect.gen(function* () {
      const pushes = yield* Queue.unbounded<PushEvent>()
      const changed = yield* run(
        Effect.gen(function* () {
          yield* Files.use((files) => files.watch(repo, ["", "src"]))
          // macOS can start the FSEvents stream after watch() returns and miss writes made before it.
          for (let attempt = 0; ; attempt++) {
            write(join(repo, `src/warmup-${attempt}.ts`), "")
            if (Option.isSome(yield* Effect.timeoutOption(Queue.take(pushes), "250 millis"))) break
          }
          yield* Effect.sleep("300 millis")
          yield* Queue.clear(pushes)
          write(join(repo, "src/burst-1.ts"), "1")
          write(join(repo, "src/burst-2.ts"), "2")
          const first = yield* Queue.take(pushes)
          yield* Effect.sleep("300 millis")
          yield* Files.use((files) => files.watch(repo, []))
          return [first, ...(yield* Queue.clear(pushes))]
        }),
        undefined,
        pushes,
      )
      expect(changed).toStrictEqual([{ type: "fs.changed", root: repo, path: "src" }])
    }),
  )

  it.effect("refuses to watch under a root it does not know", () =>
    Effect.gen(function* () {
      const error = yield* run(Files.use((files) => files.watch(outside, [""]))).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FsAccessError", reason: "unknownRoot" })
    }),
  )
})
