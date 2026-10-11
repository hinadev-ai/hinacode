import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../db/client.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { Projects } from "./Projects.ts"
import * as ProjectsLayer from "./Projects.ts"
import { Threads } from "./Threads.ts"
import * as ThreadsLayer from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"
import * as WorktreesLayer from "./Worktrees.ts"

const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

const makeRuntime = (dbPath: string) =>
  ManagedRuntime.make(
    ThreadsLayer.layer.pipe(
      Layer.provideMerge(WorktreesLayer.layer),
      Layer.provideMerge(ProjectsLayer.layer),
      Layer.provide(Layer.mergeAll(Git.layer, Layer.succeed(Events, Events.of({ publish: () => Effect.void })))),
      Layer.provideMerge(Db.layer(dbPath)),
      Layer.provide(NodeServices.layer),
    ),
  )

let dir: string
let root: string
let runtime: ReturnType<typeof makeRuntime>
let projectId: string

type Services = Threads | Worktrees | Projects | SqlClient.SqlClient
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)
const runFailure = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(Effect.flip(effect))

const createThread = (title: string, branch?: string) =>
  Threads.use((threads) =>
    threads.create({
      projectId,
      title,
      provider: "claude",
      model: "claude-sonnet-5-5",
      worktree: branch === undefined ? undefined : { branch, baseRef: "main" },
    }),
  )

const worktreeOf = (worktreeId: string | null) => Worktrees.use((worktrees) => worktrees.get(worktreeId!))

/** Rows written before ownership was enforced can point two threads at one checkout. */
const shareWorktree = (threadId: string, worktreeId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE thread SET worktree_id = ${worktreeId} WHERE id = ${threadId}`
  })

/** Setup runs in the background; with no setup script it settles on `ready` almost at once. */
const waitUntilSetUp = async (worktreeId: string | null) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await run(worktreeOf(worktreeId))).status !== "preparing") return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("setup never finished")
}

/** Removal deletes the checkout in the background after marking the row removed. */
const waitUntilDeleted = async (path: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("checkout never deleted")
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-worktrees-test-"))
  root = join(dir, "repo")
  execFileSync("git", ["init", "-q", "-b", "main", root])
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
  runtime = makeRuntime(join(dir, "kkcode.sqlite"))
  projectId = (
    await run(Projects.use((projects) => projects.create({ name: "repo", rootPath: root, setupScript: null })))
  ).id
})

afterEach(async () => {
  for (const worktree of await run(Worktrees.use((worktrees) => worktrees.list))) await waitUntilSetUp(worktree.id)
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe("worktree ownership", () => {
  test("a second thread on the same branch is refused instead of sharing the checkout", async () => {
    const first = await run(createThread("first", "kk/shared"))
    const error = await runFailure(createThread("second", "kk/shared"))
    assert.equal(error._tag, "WorktreeTakenError")
    const all = await run(Threads.use((threads) => threads.list))
    assert.deepEqual(
      all.map((thread) => thread.id),
      [first.id],
    )
  })

  test("concurrent creation of the same branch hands the checkout to one thread", async () => {
    const results = await run(
      Effect.all([createThread("a", "kk/race"), createThread("b", "kk/race")].map(Effect.result), {
        concurrency: "unbounded",
      }),
    )
    assert.equal(results.filter((result) => result._tag === "Success").length, 1)
  })

  test("settling does not remove a checkout another open thread still uses", async () => {
    const first = await run(createThread("first", "kk/legacy"))
    const second = await run(createThread("second"))
    await waitUntilSetUp(first.worktreeId)
    await run(shareWorktree(second.id, first.worktreeId))
    const worktree = await run(worktreeOf(first.worktreeId))
    writeFileSync(join(worktree.path, "sentinel"), "work in progress")

    const error = await runFailure(Threads.use((threads) => threads.settle(first.id)))
    assert.equal(error._tag, "WorktreeBusyError")
    assert.ok(existsSync(join(worktree.path, "sentinel")))
  })

  for (const status of ["running", "awaiting_approval"] as const) {
    test(`settling refuses while the thread is ${status}`, async () => {
      const thread = await run(createThread("busy", "kk/busy"))
      await waitUntilSetUp(thread.worktreeId)
      const worktree = await run(worktreeOf(thread.worktreeId))
      writeFileSync(join(worktree.path, "sentinel"), "work in progress")
      await run(Threads.use((threads) => threads.update({ id: thread.id, status })))

      const error = await runFailure(Threads.use((threads) => threads.settle(thread.id)))
      assert.equal(error._tag, "WorktreeBusyError")
      assert.ok(existsSync(join(worktree.path, "sentinel")))
      assert.equal((await run(Threads.use((threads) => threads.get(thread.id)))).status, status)
    })
  }

  test("deleting a thread with its worktree refuses while another open thread uses it", async () => {
    const first = await run(createThread("first", "kk/legacy-delete"))
    const second = await run(createThread("second"))
    await waitUntilSetUp(first.worktreeId)
    await run(shareWorktree(second.id, first.worktreeId))
    const worktree = await run(worktreeOf(first.worktreeId))

    const error = await runFailure(Threads.use((threads) => threads.remove(first.id, { removeWorktree: true })))
    assert.equal(error._tag, "WorktreeBusyError")
    assert.ok(existsSync(worktree.path))
  })

  test("settling an idle thread removes its own checkout", async () => {
    const thread = await run(createThread("done", "kk/done"))
    await waitUntilSetUp(thread.worktreeId)
    const settled = await run(Threads.use((threads) => threads.settle(thread.id)))
    assert.equal(settled.status, "settled")
    const worktree = await run(worktreeOf(thread.worktreeId))
    assert.equal(worktree.status, "removed")
    await waitUntilDeleted(worktree.path)
  })

  test("a settled branch can start a new thread without reviving the old one's worktree", async () => {
    const old = await run(createThread("old", "kk/again"))
    await waitUntilSetUp(old.worktreeId)
    await run(Threads.use((threads) => threads.settle(old.id)))

    const fresh = await run(createThread("fresh", "kk/again"))
    assert.notEqual(fresh.worktreeId, old.worktreeId)
    assert.equal((await run(worktreeOf(old.worktreeId))).status, "removed")
  })

  test("slash and dash branch names get distinct checkouts", async () => {
    const slash = await run(createThread("slash", "kk/fix"))
    const dash = await run(createThread("dash", "kk-fix"))
    assert.notEqual(slash.worktreeId, dash.worktreeId)
    const [a, b] = await run(Effect.all([worktreeOf(slash.worktreeId), worktreeOf(dash.worktreeId)]))
    assert.notEqual(a.path, b.path)
    assert.equal(git(a.path, "branch", "--show-current").trim(), "kk/fix")
    assert.equal(git(b.path, "branch", "--show-current").trim(), "kk-fix")
  })

  test("adopts a checkout a crash left between `git worktree add` and the insert", async () => {
    const orphan = join(dirname(root), ".kkcode-worktrees", basename(root), "kk-orphan")
    git(root, "worktree", "add", "-q", "-b", "kk/orphan", orphan, "main")
    writeFileSync(join(orphan, "sentinel"), "recovered")

    const thread = await run(createThread("recovered", "kk/orphan"))
    const worktree = await run(worktreeOf(thread.worktreeId))
    assert.equal(worktree.path, orphan)
    assert.ok(existsSync(join(orphan, "sentinel")))
  })
})

const restart = async () => {
  await runtime.dispose()
  runtime = makeRuntime(join(dir, "kkcode.sqlite"))
  return run(Worktrees.use((worktrees) => worktrees.list))
}

describe("startup", () => {
  test("fails setup a quit or crash interrupted, the same way on every start", async () => {
    const thread = await run(createThread("interrupted", "kk/interrupted"))
    await waitUntilSetUp(thread.worktreeId)
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE worktree SET status = 'preparing', setup_log = 'installing' WHERE id = ${thread.worktreeId}`
      }),
    )

    const [first] = await restart()
    assert.equal(first?.status, "failed")
    assert.match(first?.setupLog ?? "", /^installing\n.*interrupted/)

    const [second] = await restart()
    assert.deepEqual(second, first)
  })
})
