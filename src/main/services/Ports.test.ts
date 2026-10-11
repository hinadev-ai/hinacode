import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { Ports, layer as portsLayer } from "./Ports.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Ports | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(portsLayer.pipe(Layer.provideMerge(Db.layer(":memory:"))))))

const listenerPids: Array<number> = []

const LISTENER =
  "const s = require('net').createServer().listen(0, '127.0.0.1', () => console.log(process.pid, s.address().port))"

/**
 * Starts a TCP listener whose cwd is `cwd` and resolves with its port and pid. The shell backgrounds it
 * and exits, so the listener is not a descendant of this process, which Ports treats as kkcode's own.
 */
const listenIn = (cwd: string) =>
  new Promise<{ port: number; pid: number }>((resolve, reject) => {
    const shell = spawn("sh", ["-c", `"$0" -e "$1" &`, process.execPath, LISTENER], {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
    })
    shell.once("error", reject)
    shell.stdout.once("data", (chunk) => {
      const [pid = -1, port = -1] = String(chunk).trim().split(" ").map(Number)
      listenerPids.push(pid)
      resolve({ port, pid })
    })
  })

describe("Ports.listForThread", { skip: process.platform !== "linux" }, async () => {
  const base = await mkdtemp(join(tmpdir(), "kk-ports-"))
  after(async () => {
    for (const pid of listenerPids) process.kill(pid)
    await rm(base, { recursive: true, force: true })
  })

  test("lists a project-root listener after the thread's worktree was removed", async () => {
    const root = await mkdtemp(join(base, "repo-"))
    const listener = await listenIn(root)
    const ports = await run(
      seedThread({ rootPath: root, worktree: { path: join(base, "gone"), baseRef: "main", status: "removed" } }).pipe(
        Effect.flatMap(({ threadId }) => Ports.use((p) => p.listForThread(threadId))),
      ),
    )
    assert.deepEqual(
      ports.map(({ port, pid }) => ({ port, pid })),
      [listener],
    )
  })

  test("lists the active worktree's listener and not the project root's", async () => {
    const root = await mkdtemp(join(base, "repo-"))
    const worktree = await mkdtemp(join(base, "worktree-"))
    await listenIn(root)
    const listener = await listenIn(worktree)
    const ports = await run(
      seedThread({ rootPath: root, worktree: { path: worktree, baseRef: "main", status: "ready" } }).pipe(
        Effect.flatMap(({ threadId }) => Ports.use((p) => p.listForThread(threadId))),
      ),
    )
    assert.deepEqual(
      ports.map(({ port, pid }) => ({ port, pid })),
      [listener],
    )
  })
})
