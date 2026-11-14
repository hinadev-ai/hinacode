import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { makeExec } from "./Git.ts"

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

it.live("a timeout kills the process and every process it started", () =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "hinacode-exec-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)

    const error = yield* Effect.flip(
      exec("sh", ["-c", "sleep 1000 & echo $! > child; echo $$ > parent; wait"], dir, { timeout: "500 millis" }),
    )

    expect(error.exitCode).toBe(124)
    for (const pidFile of ["parent", "child"]) {
      expect(isRunning(Number(readFileSync(join(dir, pidFile), "utf8")))).toBe(false)
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("a process that ignores SIGTERM is killed anyway", () =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "hinacode-exec-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)

    yield* Effect.flip(
      exec("sh", ["-c", "trap '' TERM; echo $$ > pid; while :; do sleep 1; done"], dir, {
        timeout: "500 millis",
        forceKillAfter: "100 millis",
      }),
    )

    expect(isRunning(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(false)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
