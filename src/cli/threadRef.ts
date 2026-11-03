import { Result } from "effect"
import type { Thread, Worktree } from "../shared/domain.ts"
import { type CliFailure, usageError } from "./exit.ts"
import { isInside } from "./projectRef.ts"

export type ThreadRef = { kind: "id"; id: string } | { kind: "prefix"; prefix: string } | { kind: "here" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PREFIX = /^[0-9a-f-]{4,}$/i

export const parseThreadRef = (raw: string): Result.Result<ThreadRef, CliFailure> => {
  if (raw === ".") return Result.succeed({ kind: "here" })
  if (UUID.test(raw)) return Result.succeed({ kind: "id", id: raw.toLowerCase() })
  if (PREFIX.test(raw)) return Result.succeed({ kind: "prefix", prefix: raw.toLowerCase() })
  return Result.fail(
    usageError(`${raw} is not a thread. Pass . for the thread you are in, or 4+ characters of its id.`),
  )
}

const describe = (thread: Thread) => `  ${thread.id.slice(0, 8)}  ${thread.title}`

const exactlyOne = (matches: ReadonlyArray<Thread>, none: string, many: string) => {
  if (matches.length === 1) return Result.succeed(matches[0]!)
  if (matches.length === 0) return Result.fail(usageError(none))
  return Result.fail(usageError([many, ...matches.map(describe)].join("\n")))
}

export const resolveThreadRef = (
  ref: ThreadRef,
  threads: ReadonlyArray<Thread>,
  worktrees: ReadonlyArray<Worktree>,
  cwd: string,
): Result.Result<Thread, CliFailure> => {
  switch (ref.kind) {
    case "id":
      return exactlyOne(
        threads.filter((thread) => thread.id === ref.id),
        `no thread ${ref.id}`,
        "",
      )
    case "prefix":
      return exactlyOne(
        threads.filter((thread) => thread.id.startsWith(ref.prefix)),
        `no thread starts with ${ref.prefix}`,
        `${ref.prefix} matches more than one thread:`,
      )
    case "here": {
      const here = new Set(worktrees.filter((worktree) => isInside(cwd, worktree.path)).map((worktree) => worktree.id))
      return exactlyOne(
        threads.filter(
          (thread) =>
            thread.worktreeId !== null &&
            here.has(thread.worktreeId) &&
            thread.status !== "archived" &&
            thread.sideOf === null,
        ),
        `no thread works in ${cwd}`,
        `more than one thread works in ${cwd}:`,
      )
    }
  }
}
