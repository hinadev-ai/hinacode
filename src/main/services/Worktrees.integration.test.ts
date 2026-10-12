import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import type { PushEvent } from "../../shared/contract.ts"
import type { Thread, Worktree } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import { Projects } from "./Projects.ts"
import * as ProjectsLayer from "./Projects.ts"
import { Threads } from "./Threads.ts"
import * as ThreadsLayer from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"
import * as WorktreesLayer from "./Worktrees.ts"

const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

type Services = Threads | Worktrees | Projects | SqlClient.SqlClient

const makeLayer = (dbPath: string, events: Events["Service"] = Events.of({ publish: () => Effect.void })) =>
  ThreadsLayer.layer.pipe(
    Layer.provideMerge(WorktreesLayer.layer),
    Layer.provideMerge(ProjectsLayer.layer),
    Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer, Layer.succeed(Events, events))),
    Layer.provideMerge(Db.layer(dbPath)),
    Layer.provide(NodeServices.layer),
  )

interface Repo {
  readonly root: string
  readonly projectId: string
  /** Opens the same database in a fresh service layer, as a relaunch of the app would, and lists worktrees. */
  readonly restart: Effect.Effect<ReadonlyArray<Worktree>>
}

const worktreeOf = (worktreeId: string | null) => Worktrees.use((worktrees) => worktrees.get(worktreeId!))

/** Setup runs in the background; with no setup script it settles on `ready` almost at once. */
const waitUntilSetUp = (worktreeId: string | null) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((yield* worktreeOf(worktreeId)).status !== "preparing") return
      yield* Effect.sleep("20 millis")
    }
    throw new Error("setup never finished")
  })

/** Removal deletes the checkout in the background after marking the row removed. */
const waitUntilDeleted = (path: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!existsSync(path)) return
      yield* Effect.sleep("20 millis")
    }
    throw new Error("checkout never deleted")
  })

const waitForAllSetups = Worktrees.use((worktrees) => worktrees.list).pipe(
  Effect.flatMap(Effect.forEach((worktree) => waitUntilSetUp(worktree.id))),
  Effect.orDie,
)

/**
 * A throwaway git repo registered as a project, with the service layer built on a database next to
 * it. The layer is torn down only after background setups finish, so none of them writes to a closed
 * database.
 */
const withRepo = <A, E>(f: (repo: Repo) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "kk-worktrees-test-"))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    )
    const root = join(dir, "repo")
    execFileSync("git", ["init", "-q", "-b", "main", root])
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    const dbPath = join(dir, "kkcode.sqlite")
    // A separate runtime, as the app has after a relaunch; `Effect.provide` would reuse the open layers.
    const restart = Effect.acquireUseRelease(
      Effect.sync(() => ManagedRuntime.make(makeLayer(dbPath))),
      (runtime) => Effect.promise(() => runtime.runPromise(Worktrees.use((worktrees) => worktrees.list))),
      (runtime) => Effect.promise(() => runtime.dispose()),
    )
    return yield* Effect.gen(function* () {
      const project = yield* Projects.use((projects) =>
        projects.create({ name: "repo", rootPath: root, setupScript: null }),
      )
      return yield* f({ root, projectId: project.id, restart })
    }).pipe(Effect.ensuring(waitForAllSetups), Effect.provide(makeLayer(dbPath)))
  })

const createThread = (projectId: string, title: string, branch?: string) =>
  Threads.use((threads) =>
    threads.create({
      projectId,
      title,
      provider: "claude",
      model: "claude-sonnet-5-5",
      worktree: branch === undefined ? undefined : { branch, baseRef: "main" },
    }),
  )

/** Rows written before ownership was enforced can point two threads at one checkout. */
const shareWorktree = (threadId: string, worktreeId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE thread SET worktree_id = ${worktreeId} WHERE id = ${threadId}`
  })

const withinDeadline = async <A>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("worktree request or setup did not finish")), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe("background setup", () => {
  for (const exitCode of [0, 7]) {
    const status = exitCode === 0 ? "ready" : "failed"
    it(`returns from thread creation before setup finishes, then streams logs and becomes ${status}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "kk-worktrees-background-test-"))
      const root = join(dir, "repo")
      execFileSync("git", ["init", "-q", "-b", "main", root])
      git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
      const releasePath = join(root, "setup-release")
      const events: Array<PushEvent> = []
      const started = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<Worktree>()
      const runtime = ManagedRuntime.make(
        makeLayer(
          join(dir, "kkcode.sqlite"),
          Events.of({
            publish: (event) =>
              Effect.sync(() => {
                events.push(event)
                if (event.type === "worktree.setupLog" && event.chunk.includes("setup started")) started.resolve()
                if (event.type === "worktree.updated" && event.worktree.status !== "preparing") {
                  finished.resolve(event.worktree)
                }
              }),
          }),
        ),
      )
      let creation: Promise<Thread> | undefined
      try {
        const project = await runtime.runPromise(
          Projects.use((projects) =>
            projects.create({
              name: "repo",
              rootPath: root,
              setupScript: [
                'printf "setup started\\n"',
                "attempt=0",
                'while [ ! -f "$KKCODE_ROOT_PATH/setup-release" ]; do',
                "  attempt=$((attempt + 1))",
                '  if [ "$attempt" -ge 1000 ]; then exit 70; fi',
                "  sleep 0.02",
                "done",
                'printf "setup finished\\n"',
                `exit ${exitCode}`,
              ].join("\n"),
            }),
          ),
        )
        creation = runtime.runPromise(createThread(project.id, "background", "kk/background"))
        const thread = await withinDeadline(creation)
        expect(existsSync(releasePath)).toBe(false)
        expect(thread.worktreeId).not.toBeNull()
        expect(await runtime.runPromise(Threads.use((threads) => threads.get(thread.id)))).toStrictEqual(thread)
        const preparing = await runtime.runPromise(worktreeOf(thread.worktreeId))
        expect(preparing.status).toBe("preparing")
        expect(existsSync(join(preparing.path, ".git"))).toBe(true)

        await withinDeadline(started.promise)
        expect(await runtime.runPromise(Worktrees.use((worktrees) => worktrees.get(preparing.id)))).toMatchObject({
          status: "preparing",
          setupLog: "setup started\n",
        })
        writeFileSync(releasePath, "")
        const completed = await withinDeadline(finished.promise)
        const expectedLog = `setup started\nsetup finished\n${exitCode === 0 ? "" : `\nSetup script exited with code ${exitCode}\n`}`
        expect(completed).toMatchObject({ id: preparing.id, status, setupLog: expectedLog })
        expect(await runtime.runPromise(worktreeOf(thread.worktreeId))).toStrictEqual(completed)
        const streamedLog = events
          .flatMap((event) => (event.type === "worktree.setupLog" && event.id === preparing.id ? [event.chunk] : []))
          .join("")
        expect(streamedLog).toBe(expectedLog)
      } finally {
        writeFileSync(releasePath, "")
        try {
          if (creation) {
            await withinDeadline(creation)
            await withinDeadline(finished.promise)
          }
        } finally {
          await runtime.dispose()
          rmSync(dir, { recursive: true, force: true })
        }
      }
    })
  }
})

describe("worktree ownership", () => {
  it.live("a second thread on the same branch is refused instead of sharing the checkout", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const first = yield* createThread(projectId, "first", "kk/shared")
        const error = yield* Effect.flip(createThread(projectId, "second", "kk/shared"))
        expect(error._tag).toBe("WorktreeTakenError")
        const all = yield* Threads.use((threads) => threads.list)
        expect(all.map((thread) => thread.id)).toStrictEqual([first.id])
      }),
    ),
  )

  it.live("concurrent creation of the same branch hands the checkout to one thread", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [createThread(projectId, "a", "kk/race"), createThread(projectId, "b", "kk/race")].map(Effect.result),
          { concurrency: "unbounded" },
        )
        expect(results.filter((result) => result._tag === "Success").length).toBe(1)
      }),
    ),
  )

  it.live("settling does not remove a checkout another open thread still uses", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const first = yield* createThread(projectId, "first", "kk/legacy")
        const second = yield* createThread(projectId, "second")
        yield* waitUntilSetUp(first.worktreeId)
        yield* shareWorktree(second.id, first.worktreeId)
        const worktree = yield* worktreeOf(first.worktreeId)
        writeFileSync(join(worktree.path, "sentinel"), "work in progress")

        const error = yield* Effect.flip(Threads.use((threads) => threads.settle(first.id)))
        expect(error._tag).toBe("WorktreeBusyError")
        expect(existsSync(join(worktree.path, "sentinel"))).toBe(true)
      }),
    ),
  )

  for (const status of ["running", "awaiting_approval"] as const) {
    it.live(`settling refuses while the thread is ${status}`, () =>
      withRepo(({ projectId }) =>
        Effect.gen(function* () {
          const thread = yield* createThread(projectId, "busy", "kk/busy")
          yield* waitUntilSetUp(thread.worktreeId)
          const worktree = yield* worktreeOf(thread.worktreeId)
          writeFileSync(join(worktree.path, "sentinel"), "work in progress")
          yield* Threads.use((threads) => threads.update({ id: thread.id, status }))

          const error = yield* Effect.flip(Threads.use((threads) => threads.settle(thread.id)))
          expect(error._tag).toBe("WorktreeBusyError")
          expect(existsSync(join(worktree.path, "sentinel"))).toBe(true)
          expect((yield* Threads.use((threads) => threads.get(thread.id))).status).toBe(status)
        }),
      ),
    )
  }

  it.live("deleting a thread with its worktree refuses while another open thread uses it", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const first = yield* createThread(projectId, "first", "kk/legacy-delete")
        const second = yield* createThread(projectId, "second")
        yield* waitUntilSetUp(first.worktreeId)
        yield* shareWorktree(second.id, first.worktreeId)
        const worktree = yield* worktreeOf(first.worktreeId)

        const error = yield* Effect.flip(Threads.use((threads) => threads.remove(first.id, { removeWorktree: true })))
        expect(error._tag).toBe("WorktreeBusyError")
        expect(existsSync(worktree.path)).toBe(true)
      }),
    ),
  )

  it.live("settling an idle thread removes its own checkout", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const thread = yield* createThread(projectId, "done", "kk/done")
        yield* waitUntilSetUp(thread.worktreeId)
        const settled = yield* Threads.use((threads) => threads.settle(thread.id))
        expect(settled.status).toBe("settled")
        const worktree = yield* worktreeOf(thread.worktreeId)
        expect(worktree.status).toBe("removed")
        yield* waitUntilDeleted(worktree.path)
      }),
    ),
  )

  it.live("a settled branch can start a new thread without reviving the old one's worktree", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const old = yield* createThread(projectId, "old", "kk/again")
        yield* waitUntilSetUp(old.worktreeId)
        yield* Threads.use((threads) => threads.settle(old.id))

        const fresh = yield* createThread(projectId, "fresh", "kk/again")
        expect(fresh.worktreeId).not.toBe(old.worktreeId)
        expect((yield* worktreeOf(old.worktreeId)).status).toBe("removed")
      }),
    ),
  )

  it.live("slash and dash branch names get distinct checkouts", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const slash = yield* createThread(projectId, "slash", "kk/fix")
        const dash = yield* createThread(projectId, "dash", "kk-fix")
        expect(slash.worktreeId).not.toBe(dash.worktreeId)
        const [a, b] = yield* Effect.all([worktreeOf(slash.worktreeId), worktreeOf(dash.worktreeId)])
        expect(a.path).not.toBe(b.path)
        expect(git(a.path, "branch", "--show-current").trim()).toBe("kk/fix")
        expect(git(b.path, "branch", "--show-current").trim()).toBe("kk-fix")
      }),
    ),
  )

  it.live("adopts a checkout a crash left between `git worktree add` and the insert", () =>
    withRepo(({ root, projectId }) =>
      Effect.gen(function* () {
        const orphan = join(dirname(root), ".kkcode-worktrees", basename(root), "kk-orphan")
        git(root, "worktree", "add", "-q", "-b", "kk/orphan", orphan, "main")
        writeFileSync(join(orphan, "sentinel"), "recovered")

        const thread = yield* createThread(projectId, "recovered", "kk/orphan")
        const worktree = yield* worktreeOf(thread.worktreeId)
        expect(worktree.path).toBe(orphan)
        expect(existsSync(join(orphan, "sentinel"))).toBe(true)
      }),
    ),
  )
})

describe("startup", () => {
  it.live("fails setup a quit or crash interrupted, the same way on every start", () =>
    withRepo(({ projectId, restart }) =>
      Effect.gen(function* () {
        const thread = yield* createThread(projectId, "interrupted", "kk/interrupted")
        yield* waitUntilSetUp(thread.worktreeId)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE worktree SET status = 'preparing', setup_log = 'installing' WHERE id = ${thread.worktreeId}`

        const [first] = yield* restart
        expect(first?.status).toBe("failed")
        expect(first?.setupLog ?? "").toMatch(/^installing\n.*interrupted/)

        const [second] = yield* restart
        expect(second).toStrictEqual(first)
      }),
    ),
  )
})
