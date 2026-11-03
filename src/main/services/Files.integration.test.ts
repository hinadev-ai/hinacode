import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
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
  write(join(repo, "src/trace.log"), "log\n")
  write(join(repo, "src/gen/node_modules/x/y/z.js"), "z\n")
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

  it.effect("marks ignored files among tracked ones, and files several folders below an ignored folder", () =>
    Effect.gen(function* () {
      const src = byName(yield* run(list(repo, "src")))
      expect(src["trace.log"]).toMatchObject({ ignored: true, gitStatus: null })
      expect(src["a.ts"]?.ignored).toBe(false)
      const deep = yield* run(list(repo, "src/gen/node_modules/x/y"))
      expect(deep).toMatchObject([{ path: "src/gen/node_modules/x/y/z.js", ignored: true }])
    }),
  )

  it.effect("lists a project that is a folder inside its repo, relative to that folder", () =>
    Effect.gen(function* () {
      const root = join(repo, "src")
      const named = byName(yield* run(list(root, ""), { rootPath: root }))
      expect(named["a.ts"]).toMatchObject({ path: "a.ts", gitStatus: "modified", ignored: false })
      expect(named["new.ts"]?.gitStatus).toBe("untracked")
      expect(named["trace.log"]).toMatchObject({ ignored: true, gitStatus: null })
      expect(named["b.ts"]?.gitStatus).toBe(null)
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

  it.effect("leaves the index alone, so it never holds index.lock while an agent runs git", () =>
    Effect.gen(function* () {
      const index = join(repo, ".git", "index")
      utimesSync(join(repo, "README.md"), 1_000_000_000, 1_000_000_000)
      const before = readFileSync(index)
      yield* run(list(repo, ""))
      expect(readFileSync(index).equals(before)).toBe(true)
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

  it.effect("says the folder is missing once a worktree's folder is deleted on disk", () =>
    Effect.gen(function* () {
      const deleted = join(dir, "deleted-wt")
      git(repo, "worktree", "add", "-q", "-b", "deleted", deleted, "main")
      rmSync(deleted, { recursive: true, force: true })
      const seed = { rootPath: repo, worktree: { path: deleted, baseRef: "main", status: "ready" as const } }
      const error = yield* run(list(deleted, ""), seed).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FolderMissingError", path: deleted })
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

const create = (root: string, path: string, kind: "file" | "dir") =>
  run(Files.use((files) => files.create(root, path, kind)))
const rename = (root: string, from: string, to: string) => run(Files.use((files) => files.rename(root, from, to)))
const remove = (root: string, path: string) => run(Files.use((files) => files.remove(root, path)))

const scratch = (name: string) => {
  const path = `untracked/ops/${name}`
  mkdirSync(join(repo, path), { recursive: true })
  return path
}

const pathRefusals: ReadonlyArray<[string, () => string, string]> = [
  ["a path through ..", () => "../outside/new.txt", "outsideRoot"],
  ["an absolute path", () => join(outside, "new.txt"), "outsideRoot"],
  ["the root itself", () => "", "outsideRoot"],
  [".git", () => ".git", "outsideRoot"],
  ["a path inside .git", () => ".git/hooks/pre-commit", "outsideRoot"],
  ["a path through a symlink that leaves the root", () => "escape/new.txt", "outsideRoot"],
]

describe("fs.create", () => {
  it.effect("creates an empty file and a folder", () =>
    Effect.gen(function* () {
      const path = scratch("create")
      yield* create(repo, `${path}/new.txt`, "file")
      yield* create(repo, `${path}/folder`, "dir")
      expect(readFileSync(join(repo, path, "new.txt"), "utf8")).toBe("")
      expect(lstatSync(join(repo, path, "folder")).isDirectory()).toBe(true)
    }),
  )

  it.effect("refuses a name that already exists, and leaves it alone", () =>
    Effect.gen(function* () {
      const path = scratch("create-exists")
      write(join(repo, path, "taken.txt"), "kept\n")
      mkdirSync(join(repo, path, "taken"))
      const file = yield* create(repo, `${path}/taken.txt`, "file").pipe(Effect.flip)
      const folder = yield* create(repo, `${path}/taken`, "dir").pipe(Effect.flip)
      expect(file).toMatchObject({ _tag: "FsAccessError", reason: "exists" })
      expect(folder).toMatchObject({ _tag: "FsAccessError", reason: "exists" })
      expect(readFileSync(join(repo, path, "taken.txt"), "utf8")).toBe("kept\n")
    }),
  )

  for (const [name, path, reason] of pathRefusals) {
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* create(repo, path(), "file").pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FsAccessError", reason })
        expect(existsSync(join(outside, "new.txt"))).toBe(false)
      }),
    )
  }
})

describe("fs.rename", () => {
  it.effect("renames a file and a folder", () =>
    Effect.gen(function* () {
      const path = scratch("rename")
      write(join(repo, path, "old.txt"), "text\n")
      write(join(repo, path, "old-folder/inside.txt"), "inside\n")
      yield* rename(repo, `${path}/old.txt`, `${path}/new.txt`)
      yield* rename(repo, `${path}/old-folder`, `${path}/new-folder`)
      expect(readFileSync(join(repo, path, "new.txt"), "utf8")).toBe("text\n")
      expect(readFileSync(join(repo, path, "new-folder/inside.txt"), "utf8")).toBe("inside\n")
      expect(existsSync(join(repo, path, "old.txt"))).toBe(false)
      expect(existsSync(join(repo, path, "old-folder"))).toBe(false)
    }),
  )

  it.effect("refuses to overwrite an existing entry", () =>
    Effect.gen(function* () {
      const path = scratch("rename-exists")
      write(join(repo, path, "a.txt"), "a\n")
      write(join(repo, path, "b.txt"), "b\n")
      mkdirSync(join(repo, path, "empty"))
      const file = yield* rename(repo, `${path}/a.txt`, `${path}/b.txt`).pipe(Effect.flip)
      const folder = yield* rename(repo, `${path}/a.txt`, `${path}/empty`).pipe(Effect.flip)
      expect(file).toMatchObject({ _tag: "FsAccessError", reason: "exists" })
      expect(folder).toMatchObject({ _tag: "FsAccessError", reason: "exists" })
      expect(readFileSync(join(repo, path, "a.txt"), "utf8")).toBe("a\n")
      expect(readFileSync(join(repo, path, "b.txt"), "utf8")).toBe("b\n")
    }),
  )

  it.effect("allows a target that is the same entry, as a case-only rename is on a case-insensitive disk", () =>
    Effect.gen(function* () {
      const path = scratch("rename-same")
      write(join(repo, path, "same.txt"), "same\n")
      yield* rename(repo, `${path}/same.txt`, `${path}/same.txt`)
      expect(readFileSync(join(repo, path, "same.txt"), "utf8")).toBe("same\n")
    }),
  )

  it.effect("renames a symlink itself, not its target", () =>
    Effect.gen(function* () {
      const path = scratch("rename-link")
      symlinkSync(outside, join(repo, path, "link"))
      yield* rename(repo, `${path}/link`, `${path}/moved`)
      expect(lstatSync(join(repo, path, "moved")).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret\n")
    }),
  )

  it.effect("refuses a missing source", () =>
    Effect.gen(function* () {
      const path = scratch("rename-missing")
      const error = yield* rename(repo, `${path}/missing.txt`, `${path}/new.txt`).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FsAccessError", reason: "unreadable" })
    }),
  )

  for (const [name, path, reason] of pathRefusals) {
    it.effect(`refuses to rename to or from ${name}`, () =>
      Effect.gen(function* () {
        const folder = scratch(`rename-refusal-${name.replaceAll(/\W/g, "-")}`)
        write(join(repo, folder, "file.txt"), "file\n")
        const to = yield* rename(repo, `${folder}/file.txt`, path()).pipe(Effect.flip)
        const from = yield* rename(repo, path(), `${folder}/other.txt`).pipe(Effect.flip)
        expect(to).toMatchObject({ _tag: "FsAccessError", reason })
        expect(from).toMatchObject({ _tag: "FsAccessError", reason })
        expect(readFileSync(join(repo, folder, "file.txt"), "utf8")).toBe("file\n")
        expect(existsSync(join(outside, "new.txt"))).toBe(false)
      }),
    )
  }
})

describe("fs.delete", () => {
  it.effect("deletes a file and a folder with everything inside", () =>
    Effect.gen(function* () {
      const path = scratch("delete")
      write(join(repo, path, "file.txt"), "file\n")
      write(join(repo, path, "folder/deep/inside.txt"), "inside\n")
      yield* remove(repo, `${path}/file.txt`)
      yield* remove(repo, `${path}/folder`)
      expect(existsSync(join(repo, path, "file.txt"))).toBe(false)
      expect(existsSync(join(repo, path, "folder"))).toBe(false)
    }),
  )

  it.effect("deletes a symlink and keeps what it points to", () =>
    Effect.gen(function* () {
      const path = scratch("delete-link")
      symlinkSync(outside, join(repo, path, "folder-link"))
      symlinkSync(join(outside, "secret.txt"), join(repo, path, "file-link"))
      yield* remove(repo, `${path}/folder-link`)
      yield* remove(repo, `${path}/file-link`)
      expect(existsSync(join(repo, path, "folder-link"))).toBe(false)
      expect(existsSync(join(repo, path, "file-link"))).toBe(false)
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret\n")
    }),
  )

  it.effect("refuses a missing entry", () =>
    Effect.gen(function* () {
      const error = yield* remove(repo, `${scratch("delete-missing")}/missing.txt`).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "FsAccessError", reason: "unreadable" })
    }),
  )

  for (const [name, path, reason] of pathRefusals) {
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* remove(repo, path()).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FsAccessError", reason })
        expect(existsSync(join(repo, ".git"))).toBe(true)
        expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret\n")
      }),
    )
  }
})

describe("fs.watch", () => {
  it.live("pushes fs.changed for a watched folder, once per burst", () =>
    Effect.gen(function* () {
      const pushes = yield* Queue.unbounded<PushEvent>()
      const changed = yield* run(
        Effect.gen(function* () {
          yield* Files.use((files) => files.watch(repo, ["", "src"]))
          // FIXME: macOS can start the FSEvents stream after watch() returns and miss earlier writes
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
