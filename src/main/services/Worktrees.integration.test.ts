import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Context, Deferred, Effect, Fiber, Layer, ManagedRuntime, PubSub } from "effect"
import { SqlClient } from "effect/sql"
import type { PushEvent } from "../../shared/contract.ts"
import type { Thread, Worktree } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import { Projects } from "./Projects.ts"
import * as ProjectsLayer from "./Projects.ts"
import * as Terminals from "./Terminals.ts"
import { Threads } from "./Threads.ts"
import { Settings } from "./Settings.ts"
import * as SettingsLayer from "./Settings.ts"
import * as ThreadsLayer from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"
import * as WorktreesLayer from "./Worktrees.ts"

const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

type Services = Threads | Worktrees | Projects | Settings | SqlClient.SqlClient | Pushes

/** What the service would push to the renderer; tests wait on these instead of polling the database. */
class Pushes extends Context.Service<Pushes, PubSub.PubSub<PushEvent>>()("test/Pushes") {}

const makeLayer = (
  dbPath: string,
  pushes: PubSub.PubSub<PushEvent>,
  events: Events["Service"] = Events.of({ publish: (event) => Effect.asVoid(PubSub.publish(pushes, event)) }),
) =>
  ThreadsLayer.layer.pipe(
    Layer.provide(Terminals.layer),
    Layer.provideMerge(WorktreesLayer.layer),
    Layer.provideMerge(ProjectsLayer.layer),
    Layer.provide(AgentAccounts.layer),
    Layer.provideMerge(SettingsLayer.layer),
    Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer, Layer.succeed(Events, events))),
    Layer.provideMerge(Db.layer(dbPath)),
    Layer.provideMerge(Layer.succeed(Pushes, pushes)),
    Layer.provide(NodeServices.layer),
  )

interface Repo {
  readonly root: string
  readonly projectId: string
  /** Opens the same database in a fresh service layer, as a relaunch of the app would, and lists worktrees. */
  readonly restart: Effect.Effect<ReadonlyArray<Worktree>>
}

const worktreeOf = (worktreeId: string | null) => Worktrees.use((worktrees) => worktrees.get(worktreeId!))

/**
 * Setup runs in the background and ends with a `worktree.updated` push. Subscribing before reading the
 * row means a push between the two cannot be missed.
 */
const waitUntilSetUp = (worktreeId: string | null) =>
  Effect.gen(function* () {
    const updates = yield* PubSub.subscribe(yield* Pushes)
    if ((yield* worktreeOf(worktreeId)).status !== "preparing") return
    while (true) {
      const event = yield* PubSub.take(updates)
      if (
        event.type === "worktree.updated" &&
        event.worktree.id === worktreeId &&
        event.worktree.status !== "preparing"
      )
        return
    }
  }).pipe(Effect.scoped)

/** Removal deletes the checkout in the background after marking the row removed; the parent directory reports it. */
const waitUntilDeleted = (path: string) =>
  Effect.callback<void>((resume) => {
    let done = false
    const check = () => {
      if (done || existsSync(path)) return
      done = true
      watcher.close()
      resume(Effect.void)
    }
    const watcher = watch(dirname(path), check)
    check()
    return Effect.sync(() => watcher.close())
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
const withRepo = <A, E>(
  f: (repo: Repo) => Effect.Effect<A, E, Services>,
  events?: (pushes: PubSub.PubSub<PushEvent>) => Events["Service"],
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "kk-worktrees-test-"))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    )
    // Unresolved on purpose. macOS's temp dir goes through the /var symlink, and git reports resolved paths.
    const root = join(dir, "repo")
    execFileSync("git", ["init", "-q", "-b", "main", root])
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    const dbPath = join(dir, "kkcode.sqlite")
    const pushes = yield* PubSub.unbounded<PushEvent>()
    // A separate runtime, as the app has after a relaunch; `Effect.provide` would reuse the open layers.
    const restart = Effect.acquireUseRelease(
      Effect.sync(() => ManagedRuntime.make(makeLayer(dbPath, pushes))),
      (runtime) => Effect.promise(() => runtime.runPromise(Worktrees.use((worktrees) => worktrees.list))),
      (runtime) => Effect.promise(() => runtime.dispose()),
    )
    return yield* Effect.gen(function* () {
      const project = yield* Projects.use((projects) =>
        projects.create({ name: "repo", rootPath: root, setupScript: null }),
      )
      return yield* f({ root, projectId: project.id, restart })
    }).pipe(Effect.ensuring(waitForAllSetups), Effect.provide(makeLayer(dbPath, pushes, events?.(pushes))))
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

const archiveRemovingWorktree = (threadId: string) =>
  Settings.use((settings) => settings.set({ archive: { whenMerged: false, removeWorktree: true } })).pipe(
    Effect.andThen(Threads.use((threads) => threads.archive(threadId))),
  )

/** Rows written before ownership was enforced can point two threads at one checkout. */
const shareWorktree = (threadId: string, worktreeId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE thread SET worktree_id = ${worktreeId} WHERE id = ${threadId}`
  })

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
          Effect.runSync(PubSub.unbounded<PushEvent>()),
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
        const thread = await creation
        expect(existsSync(releasePath)).toBe(false)
        expect(thread.worktreeId).not.toBeNull()
        expect(await runtime.runPromise(Threads.use((threads) => threads.get(thread.id)))).toStrictEqual(thread)
        const preparing = await runtime.runPromise(worktreeOf(thread.worktreeId))
        expect(preparing.status).toBe("preparing")
        expect(existsSync(join(preparing.path, ".git"))).toBe(true)

        await started.promise
        expect(await runtime.runPromise(Worktrees.use((worktrees) => worktrees.get(preparing.id)))).toMatchObject({
          status: "preparing",
          setupLog: "setup started\n",
        })
        writeFileSync(releasePath, "")
        const completed = await finished.promise
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
            await creation
            await finished.promise
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

  it.live("archiving does not remove a checkout another open thread still uses", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const first = yield* createThread(projectId, "first", "kk/legacy")
        const second = yield* createThread(projectId, "second")
        yield* waitUntilSetUp(first.worktreeId)
        yield* shareWorktree(second.id, first.worktreeId)
        const worktree = yield* worktreeOf(first.worktreeId)
        writeFileSync(join(worktree.path, "sentinel"), "work in progress")

        const error = yield* Effect.flip(archiveRemovingWorktree(first.id))
        expect(error._tag).toBe("WorktreeBusyError")
        expect(existsSync(join(worktree.path, "sentinel"))).toBe(true)
      }),
    ),
  )

  for (const status of ["running", "awaiting_approval"] as const) {
    it.live(`archiving with worktree removal refuses while the thread is ${status}`, () =>
      withRepo(({ projectId }) =>
        Effect.gen(function* () {
          const thread = yield* createThread(projectId, "busy", "kk/busy")
          yield* waitUntilSetUp(thread.worktreeId)
          const worktree = yield* worktreeOf(thread.worktreeId)
          writeFileSync(join(worktree.path, "sentinel"), "work in progress")
          yield* Threads.use((threads) => threads.update({ id: thread.id, status }))

          const error = yield* Effect.flip(archiveRemovingWorktree(thread.id))
          expect(error._tag).toBe("ThreadBusyError")
          expect(existsSync(join(worktree.path, "sentinel"))).toBe(true)
          expect((yield* Threads.use((threads) => threads.get(thread.id))).status).toBe(status)
        }),
      ),
    )

    it.live(`archiving refuses a ${status} thread that keeps its worktree`, () =>
      withRepo(({ projectId }) =>
        Effect.gen(function* () {
          const thread = yield* createThread(projectId, "busy", "kk/busy")
          yield* waitUntilSetUp(thread.worktreeId)
          yield* Threads.use((threads) => threads.update({ id: thread.id, status }))

          const archived = yield* Effect.exit(Threads.use((threads) => threads.archive(thread.id)))
          expect(archived._tag).toBe("Failure")
          expect((yield* Threads.use((threads) => threads.get(thread.id))).status).toBe(status)
        }),
      ),
    )

    it.live(`archiving with worktree removal refuses a ${status} thread in the project root`, () =>
      withRepo(({ projectId }) =>
        Effect.gen(function* () {
          const thread = yield* createThread(projectId, "busy")
          yield* Threads.use((threads) => threads.update({ id: thread.id, status }))

          const archived = yield* Effect.exit(archiveRemovingWorktree(thread.id))
          expect(archived._tag).toBe("Failure")
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

  it.live("archiving keeps the checkout unless the settings remove it, and unarchiving brings the thread back", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const thread = yield* createThread(projectId, "paused", "kk/paused")
        yield* waitUntilSetUp(thread.worktreeId)
        const archived = yield* Threads.use((threads) => threads.archive(thread.id))
        expect(archived.status).toBe("archived")
        const worktree = yield* worktreeOf(thread.worktreeId)
        expect(worktree.status).toBe("ready")
        expect(existsSync(worktree.path)).toBe(true)

        const restored = yield* Threads.use((threads) => threads.unarchive(thread.id))
        expect(restored.status).toBe("idle")
      }),
    ),
  )

  it.live("archiving an idle thread with worktree removal on removes its own checkout", () =>
    withRepo(({ root, projectId }) =>
      Effect.gen(function* () {
        const thread = yield* createThread(projectId, "done", "kk/done")
        yield* waitUntilSetUp(thread.worktreeId)
        const { path } = yield* worktreeOf(thread.worktreeId)
        expect(git(root, "worktree", "list", "--porcelain")).toContain(`worktree ${path}\n`)
        const archived = yield* archiveRemovingWorktree(thread.id)
        expect(archived.status).toBe("archived")
        const worktree = yield* worktreeOf(thread.worktreeId)
        expect(worktree.status).toBe("removed")
        yield* waitUntilDeleted(worktree.path)
      }),
    ),
  )

  it.live("archiving keeps the title, model and access mode saved while it removed the worktree", () =>
    Effect.gen(function* () {
      const removed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holdRemoval = (pushes: PubSub.PubSub<PushEvent>) =>
        Events.of({
          publish: (event) =>
            Effect.gen(function* () {
              if (event.type === "worktree.updated" && event.worktree.status === "removed") {
                yield* Deferred.succeed(removed, undefined)
                yield* Deferred.await(release)
              }
              yield* PubSub.publish(pushes, event)
            }),
        })
      yield* withRepo(
        ({ projectId }) =>
          Effect.gen(function* () {
            const thread = yield* createThread(projectId, "before", "kk/renamed")
            yield* waitUntilSetUp(thread.worktreeId)
            const archiving = yield* archiveRemovingWorktree(thread.id).pipe(Effect.forkChild)
            yield* Deferred.await(removed)
            yield* Threads.use((threads) =>
              threads.update({ id: thread.id, title: "after", model: "claude-opus-5-5", accessMode: "supervised" }),
            )
            yield* Deferred.succeed(release, undefined)

            const archived = yield* Fiber.join(archiving)
            const saved = yield* Threads.use((threads) => threads.get(thread.id))
            for (const result of [archived, saved]) {
              expect(result).toMatchObject({
                status: "archived",
                title: "after",
                model: "claude-opus-5-5",
                accessMode: "supervised",
              })
            }
            yield* waitUntilDeleted((yield* worktreeOf(thread.worktreeId)).path)
          }),
        holdRemoval,
      )
    }),
  )

  it.live("an archived branch can start a new thread without reviving the old one's worktree", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const old = yield* createThread(projectId, "old", "kk/again")
        yield* waitUntilSetUp(old.worktreeId)
        yield* archiveRemovingWorktree(old.id)

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
        expect(worktree.path).toBe(realpathSync(orphan))
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

describe("thread changes", () => {
  it.live("the worktree scope covers commits, edits and new files since the fork, and is null once removed", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const thread = yield* createThread(projectId, "diff", "kk/diff")
        yield* waitUntilSetUp(thread.worktreeId)
        const { path } = yield* worktreeOf(thread.worktreeId)
        writeFileSync(join(path, "committed.txt"), "one\n")
        git(path, "add", "committed.txt")
        git(path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work")
        writeFileSync(join(path, "new.txt"), "fresh\n")

        const changes = yield* Threads.use((threads) => threads.changes(thread.id, "worktree"))
        expect(changes?.files).toStrictEqual([
          { path: "committed.txt", status: "added" },
          { path: "new.txt", status: "added" },
        ])
        expect(changes?.patch).toContain("diff --git a/new.txt b/new.txt")
        expect(changes?.patch).toContain("+fresh")

        yield* archiveRemovingWorktree(thread.id)
        expect(yield* Threads.use((threads) => threads.changes(thread.id, "worktree"))).toBeNull()
      }),
    ),
  )

  it.live("the worktree scope is null for a thread working in the project root", () =>
    withRepo(({ projectId }) =>
      Effect.gen(function* () {
        const thread = yield* createThread(projectId, "root")
        expect(yield* Threads.use((threads) => threads.changes(thread.id, "worktree"))).toBeNull()
      }),
    ),
  )

  it.live("the turn scope diffs against the stored turn base, and is null without one", () =>
    withRepo(({ root, projectId }) =>
      Effect.gen(function* () {
        const thread = yield* createThread(projectId, "turn")
        writeFileSync(join(root, "before-turn.txt"), "old\n")
        expect(yield* Threads.use((threads) => threads.changes(thread.id, "turn"))).toBeNull()

        yield* Threads.use((threads) => threads.snapshotTurnBase(thread.id, root))
        writeFileSync(join(root, "during-turn.txt"), "new\n")

        const changes = yield* Threads.use((threads) => threads.changes(thread.id, "turn"))
        expect(changes?.files).toStrictEqual([{ path: "during-turn.txt", status: "added" }])

        yield* Threads.use((threads) => threads.snapshotTurnBase(thread.id, join(root, "missing")))
        expect(yield* Threads.use((threads) => threads.changes(thread.id, "turn"))).toBeNull()
      }),
    ),
  )
})

const commit = (cwd: string, message: string) => {
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message)
  return git(cwd, "rev-parse", "HEAD").trim()
}

/**
 * Gives the repo an `origin` holding a pull request branch and a fork's pull request, which GitHub only
 * serves as `refs/pull/<n>/head`. Neither exists locally, as for a pull request someone else opened.
 */
const withOrigin = (root: string) => {
  const origin = join(dirname(root), "origin.git")
  execFileSync("git", ["init", "-q", "--bare", origin])
  git(root, "remote", "add", "origin", origin)
  git(root, "push", "-q", "origin", "main")
  git(root, "switch", "-q", "-c", "feature/login")
  const branchHead = commit(root, "fix login")
  git(root, "push", "-q", "origin", "feature/login")
  git(root, "switch", "-q", "-c", "fork-work", "main")
  const forkHead = commit(root, "fork change")
  git(root, "push", "-q", "origin", "fork-work:refs/pull/8/head")
  git(root, "switch", "-q", "main")
  git(root, "branch", "-q", "-D", "feature/login", "fork-work")
  git(root, "update-ref", "-d", "refs/remotes/origin/feature/login")
  return { branchHead, forkHead }
}

const pullRequestHead = (overrides: Partial<GitHub.PullRequestHead>): GitHub.PullRequestHead => ({
  url: "https://github.com/acme/repo/pull/7",
  number: 7,
  headRefName: "feature/login",
  baseRefName: "main",
  isCrossRepository: false,
  ...overrides,
})

describe("worktrees from pull requests", () => {
  it.live("checks out the pull request's branch, tracking origin so pushes update the pull request", () =>
    withRepo(({ root, projectId }) =>
      Effect.gen(function* () {
        const { branchHead } = withOrigin(root)
        const worktree = yield* Worktrees.use((worktrees) =>
          worktrees.createFromPullRequest(projectId, pullRequestHead({})),
        )
        expect({ branch: worktree.branch, baseRef: worktree.baseRef }).toStrictEqual({
          branch: "feature/login",
          baseRef: "main",
        })
        expect(git(worktree.path, "rev-parse", "HEAD").trim()).toBe(branchHead)
        expect(git(worktree.path, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/feature/login")
      }),
    ),
  )

  it.live("checks out a fork's pull request on a local kk/pr-<number> branch", () =>
    withRepo(({ root, projectId }) =>
      Effect.gen(function* () {
        const { forkHead } = withOrigin(root)
        const worktree = yield* Worktrees.use((worktrees) =>
          worktrees.createFromPullRequest(
            projectId,
            pullRequestHead({ number: 8, headRefName: "fork-work", isCrossRepository: true }),
          ),
        )
        expect(worktree.branch).toBe("kk/pr-8")
        expect(git(worktree.path, "rev-parse", "HEAD").trim()).toBe(forkHead)
      }),
    ),
  )
})

describe("branch suggestions", () => {
  it.live("lists local branches newest first, then origin's branches that have no local copy", () =>
    withRepo(({ root, projectId }) =>
      Effect.gen(function* () {
        withOrigin(root)
        git(root, "fetch", "-q", "origin")
        git(root, "switch", "-q", "-c", "kk/recent")
        execFileSync(
          "git",
          ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "recent"],
          {
            env: { ...process.env, GIT_COMMITTER_DATE: "2030-01-01T00:00:00" },
          },
        )
        git(root, "switch", "-q", "main")
        const branches = yield* Worktrees.use((worktrees) => worktrees.branches(projectId))
        expect(branches).toStrictEqual(["kk/recent", "main", "origin/feature/login"])
      }),
    ),
  )
})
