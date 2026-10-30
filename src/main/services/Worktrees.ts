import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import {
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient, SqlSchema } from "effect/sql"
import {
  type Changes,
  isThreadBusy,
  type Project,
  type PullRequest,
  ThreadStatus,
  Worktree,
  type WorktreeCheckout,
  type WorktreeStatus,
} from "../../shared/domain.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  persistence,
  RootBusyError,
  WorktreeBusyError,
  WorktreeTakenError,
} from "./errors.ts"
import { Events } from "./Events.ts"
import { type CommandError, Git } from "./Git.ts"
import { GitHub, type GitHubError, type PullRequestHead } from "./GitHub.ts"
import { Projects } from "./Projects.ts"
import { Settings } from "./Settings.ts"
import { diffWorkingTree } from "./workingTree.ts"

export interface CreateWorktree {
  readonly projectId: string
  readonly branch: string
  readonly baseRef: string
  readonly startPoint?: string
}

export type DeleteBranch = "keep" | "ifMerged" | "force"

type Failure = PersistenceError | NotFoundError | CommandError

export class Worktrees extends Context.Service<
  Worktrees,
  {
    readonly list: Effect.Effect<ReadonlyArray<Worktree>, PersistenceError>
    readonly checkouts: Effect.Effect<ReadonlyArray<WorktreeCheckout>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Worktree, PersistenceError | NotFoundError>
    readonly create: (input: CreateWorktree) => Effect.Effect<Worktree, Failure | WorktreeTakenError>
    readonly createFromPullRequest: (
      projectId: string,
      head: PullRequestHead,
    ) => Effect.Effect<Worktree, Failure | WorktreeTakenError>
    readonly checkout: (projectId: string, ref: string, owner: string) => Effect.Effect<void, Failure | RootBusyError>
    readonly checkoutPullRequest: (
      projectId: string,
      head: PullRequestHead,
      owner: string,
    ) => Effect.Effect<void, Failure | RootBusyError>
    readonly remove: (
      id: string,
      deleteBranch: DeleteBranch,
      owner?: string,
    ) => Effect.Effect<Worktree, Failure | WorktreeBusyError>
    readonly removeWhileExclusive: (
      id: string,
      deleteBranch: DeleteBranch,
      owner?: string,
    ) => Effect.Effect<Worktree, Failure | WorktreeBusyError>
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    readonly renameBranch: (id: string, branch: string) => Effect.Effect<Worktree, Failure>
    readonly changes: (id: string) => Effect.Effect<Changes | null, Failure | PlatformError.PlatformError>
    readonly pullRequest: (
      id: string,
    ) => Effect.Effect<PullRequest | null, PersistenceError | NotFoundError | GitHubError | Schema.SchemaError>
    readonly currentBranch: (projectId: string) => Effect.Effect<string, Failure>
    readonly branches: (projectId: string) => Effect.Effect<ReadonlyArray<string>, Failure>
    readonly defaultBranch: (projectId: string) => Effect.Effect<string, PersistenceError | NotFoundError>
    readonly fetch: (projectId: string) => Effect.Effect<void, Failure>
    readonly whenPrepared: (id: string) => Effect.Effect<Worktree, PersistenceError | NotFoundError>
    readonly stopSetup: (id: string) => Effect.Effect<void>
  }
>()("hinacode/Worktrees") {}

const checkoutsDir = (rootPath: string, worktreeRoot: string | null) =>
  join(worktreeRoot ?? join(dirname(rootPath), ".hinacode-worktrees"), basename(rootPath))

const checkoutPath = (checkouts: string, branch: string, id: string) =>
  join(checkouts, `${branch.replaceAll("/", "-")}-${id.slice(0, 8)}`)

export const forkPullRequestBranch = (number: number) => `kk/pr-${number}`

const removalKey = (projectId: string, branch: string) => `${projectId}\0${branch}`

const parseCheckouts = (output: string) =>
  output
    .split("\0\0")
    .map((record) => {
      const fields = record.split("\0")
      const value = (key: string) => fields.find((field) => field.startsWith(`${key} `))?.slice(key.length + 1)
      return { path: value("worktree") ?? "", ref: value("branch") ?? null }
    })
    .filter((checkout) => checkout.path !== "")

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const git = yield* Git
  const github = yield* GitHub
  const events = yield* Events
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const settings = yield* Settings
  const resolve = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path))
  const gitContext = yield* Effect.context<Git | FileSystem.FileSystem>()

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Worktree,
    execute: () => sql`SELECT * FROM worktree ORDER BY created_at`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Worktree,
    execute: (id) => sql`SELECT * FROM worktree WHERE id = ${id}`,
  })
  const findLive = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: Schema.String, branch: Schema.String }),
    Result: Worktree,
    execute: ({ projectId, branch }) =>
      sql`SELECT * FROM worktree WHERE project_id = ${projectId} AND branch = ${branch} AND status != 'removed'`,
  })
  const findByPath = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Worktree,
    execute: (path) => sql`SELECT * FROM worktree WHERE path = ${path}`,
  })
  const findRootUsers = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, status: ThreadStatus }),
    execute: (projectId) => sql`SELECT id, status FROM thread WHERE project_id = ${projectId} AND worktree_id IS NULL`,
  })
  const findUsers = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, status: ThreadStatus, sideOf: Schema.NullOr(Schema.String) }),
    execute: (worktreeId) => sql`SELECT id, status, side_of FROM thread WHERE worktree_id = ${worktreeId}`,
  })

  yield* sql`
    UPDATE worktree SET status = 'failed', setup_log = setup_log || ${"\nSetup was interrupted when HinaCode quit.\n"}
    WHERE status = 'preparing'
  `.pipe(Effect.mapError(persistence("worktrees.failInterrupted")))

  const lock = Semaphore.makeUnsafe(1)
  const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect)

  const get = (id: string) =>
    findById(id).pipe(
      Effect.mapError(persistence("worktrees.get")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFoundError({ entity: "worktree", id })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const publishCurrent = (id: string) =>
    get(id).pipe(Effect.tap((worktree) => events.publish({ type: "worktree.updated", worktree })))

  const setStatus = (id: string, status: WorktreeStatus) =>
    sql`UPDATE worktree SET status = ${status} WHERE id = ${id}`.pipe(
      Effect.mapError(persistence("worktrees.setStatus")),
      Effect.andThen(publishCurrent(id)),
    )

  const appendLog = (id: string, chunk: string) =>
    sql`UPDATE worktree SET setup_log = setup_log || ${chunk} WHERE id = ${id}`.pipe(
      Effect.mapError(persistence("worktrees.appendLog")),
      Effect.andThen(events.publish({ type: "worktree.setupLog", id, chunk })),
    )

  const registeredCheckouts = (rootPath: string) =>
    git.run(rootPath, ["worktree", "list", "--porcelain", "-z"]).pipe(Effect.map(parseCheckouts))

  const branchExists = (rootPath: string, branch: string) =>
    git
      .run(rootPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { okExitCodes: [1] })
      .pipe(Effect.map((output) => output.trim() !== ""))

  const isMerged = (rootPath: string, branch: string, baseRef: string) =>
    git.run(rootPath, ["branch", "--merged", baseRef, "--format=%(refname:short)"]).pipe(
      Effect.map((output) => output.split("\n").includes(branch)),
      Effect.orElseSucceed(() => false),
    )

  const runSetupScript = (worktree: Worktree, project: Project, script: string) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.env["SHELL"] || "/bin/sh", ["-lc", script], {
          cwd: worktree.path,
          env: {
            HINACODE_ROOT_PATH: project.rootPath,
            HINACODE_WORKTREE_PATH: worktree.path,
            HINACODE_BRANCH: worktree.branch,
          },
          extendEnv: true,
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        }),
      )
      yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => appendLog(worktree.id, chunk)),
      )
      return yield* handle.exitCode
    }).pipe(
      Effect.scoped,
      Effect.catchTag("PlatformError", (error) => appendLog(worktree.id, `${error.message}\n`).pipe(Effect.as(-1))),
    )

  const setup = (worktree: Worktree, project: Project) =>
    Effect.gen(function* () {
      const script = project.setupScript?.trim()
      if (!script) return yield* setStatus(worktree.id, "ready")
      const exitCode = yield* runSetupScript(worktree, project, script)
      if (exitCode === 0) return yield* setStatus(worktree.id, "ready")
      yield* appendLog(worktree.id, `\nSetup script exited with code ${exitCode}\n`)
      return yield* setStatus(worktree.id, "failed")
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("worktree setup failed", cause).pipe(
          Effect.andThen(setStatus(worktree.id, "failed")),
          Effect.ignore,
        ),
      ),
      Effect.onInterrupt(() =>
        appendLog(worktree.id, "\nSetup script was stopped.\n").pipe(
          Effect.andThen(setStatus(worktree.id, "failed")),
          Effect.ignore,
        ),
      ),
    )

  const setups = new Map<string, Fiber.Fiber<unknown>>()

  const whenPrepared = (id: string) =>
    Effect.gen(function* () {
      const running = setups.get(id)
      if (running !== undefined) {
        yield* Fiber.await(running)
        setups.delete(id)
      }
      return yield* get(id)
    })

  const stopSetup = (id: string) => {
    const running = setups.get(id)
    return running === undefined ? Effect.void : Fiber.interrupt(running)
  }

  const removals = new Map<string, Fiber.Fiber<void>>()

  const findOrphan = (rootPath: string, checkouts: string, branch: string) =>
    Effect.gen(function* () {
      const checkout = (yield* registeredCheckouts(rootPath)).find(
        ({ path, ref }) => ref === `refs/heads/${branch}` && dirname(path) === checkouts,
      )
      if (!checkout) return Option.none()
      const recorded = yield* findByPath(checkout.path).pipe(Effect.mapError(persistence("worktrees.create")))
      return Option.isNone(recorded) ? Option.some(checkout.path) : Option.none()
    })

  const create = (input: CreateWorktree) =>
    Effect.gen(function* () {
      const project = yield* projects.get(input.projectId)
      const removal = removals.get(removalKey(project.id, input.branch))
      if (removal) yield* Fiber.await(removal)
      const live = yield* findLive({ projectId: project.id, branch: input.branch }).pipe(
        Effect.mapError(persistence("worktrees.create")),
      )
      if (Option.isSome(live)) {
        return yield* new WorktreeTakenError({ branch: input.branch, path: live.value.path })
      }

      // FIXME: git reports checkouts by their resolved path
      const rootPath = yield* resolve(project.rootPath)
      const { worktreeRoot } = yield* settings.get
      const checkouts = checkoutsDir(rootPath, worktreeRoot === null ? null : yield* resolve(worktreeRoot))
      const id = randomUUID()
      const orphan = yield* findOrphan(rootPath, checkouts, input.branch)
      const path = Option.getOrElse(orphan, () => checkoutPath(checkouts, input.branch, id))
      if (Option.isNone(orphan)) {
        const args = (yield* branchExists(rootPath, input.branch))
          ? ["worktree", "add", path, input.branch]
          : input.startPoint === undefined
            ? // FIXME: forking from `origin/main` makes it the upstream, and a plain `git push` then fails
              ["worktree", "add", "--no-track", "-b", input.branch, path, input.baseRef]
            : ["worktree", "add", "-b", input.branch, path, input.startPoint]
        yield* git.run(rootPath, args)
      }

      const worktree: Worktree = {
        id,
        projectId: project.id,
        path: yield* resolve(path),
        branch: input.branch,
        baseRef: input.baseRef,
        status: "preparing",
        setupLog: "",
        createdAt: yield* nowIso,
      }
      yield* sql`INSERT INTO worktree ${sql.insert(worktree)}`.pipe(Effect.mapError(persistence("worktrees.create")))
      yield* events.publish({ type: "worktree.updated", worktree })
      setups.set(worktree.id, yield* Effect.forkDetach(setup(worktree, project)))
      return worktree
    }).pipe(exclusive)

  const fetchPullRequest = (rootPath: string, head: PullRequestHead) =>
    Effect.gen(function* () {
      const [branch, source, fetched] = head.isCrossRepository
        ? [forkPullRequestBranch(head.number), `refs/pull/${head.number}/head`, `refs/hinacode/pull/${head.number}`]
        : [head.headRefName, `refs/heads/${head.headRefName}`, `refs/remotes/origin/${head.headRefName}`]
      yield* git.remote(rootPath, ["fetch", "--quiet", "origin", `+${source}:${fetched}`])
      return { branch, startPoint: fetched }
    })

  const createFromPullRequest = (projectId: string, head: PullRequestHead) =>
    Effect.gen(function* () {
      const { rootPath } = yield* projects.get(projectId)
      const { branch, startPoint } = yield* fetchPullRequest(rootPath, head)
      return yield* create({ projectId, branch, baseRef: head.baseRefName, startPoint })
    })

  const switchRoot = (projectId: string, rootPath: string, owner: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const users = yield* findRootUsers(projectId).pipe(Effect.mapError(persistence("worktrees.checkout")))
      if (users.some((thread) => thread.id !== owner && isThreadBusy(thread.status))) {
        return yield* new RootBusyError({ path: rootPath })
      }
      yield* git.run(rootPath, ["switch", ...args])
    }).pipe(exclusive)

  const checkout = (projectId: string, ref: string, owner: string) =>
    Effect.gen(function* () {
      const { rootPath } = yield* projects.get(projectId)
      const remote =
        ref.startsWith("origin/") &&
        (yield* git
          .run(rootPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`], { okExitCodes: [1] })
          .pipe(Effect.map((output) => output.trim() !== "")))
      yield* switchRoot(projectId, rootPath, owner, remote ? ["--track", ref] : [ref])
    })

  const checkoutPullRequest = (projectId: string, head: PullRequestHead, owner: string) =>
    Effect.gen(function* () {
      const { rootPath } = yield* projects.get(projectId)
      const { branch, startPoint } = yield* fetchPullRequest(rootPath, head)
      const args = (yield* branchExists(rootPath, branch)) ? [branch] : ["-c", branch, startPoint]
      yield* switchRoot(projectId, rootPath, owner, args)
    })

  const renameBranch = (id: string, branch: string) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      const { rootPath } = yield* projects.get(worktree.projectId)
      yield* git.run(rootPath, ["branch", "-m", worktree.branch, branch])
      yield* sql`UPDATE worktree SET branch = ${branch} WHERE id = ${id}`.pipe(
        Effect.mapError(persistence("worktrees.renameBranch")),
      )
      return yield* publishCurrent(id)
    }).pipe(exclusive)

  const ensureRemovable = (worktree: Worktree, owner: string | undefined) =>
    Effect.gen(function* () {
      const users = yield* findUsers(worktree.id).pipe(Effect.mapError(persistence("worktrees.remove")))
      if (users.some((thread) => isThreadBusy(thread.status))) {
        return yield* new WorktreeBusyError({ path: worktree.path, reason: "turn" })
      }
      const othersOpen = users.some(
        (thread) => thread.id !== owner && thread.sideOf !== owner && thread.status !== "archived",
      )
      if (owner !== undefined && othersOpen) {
        return yield* new WorktreeBusyError({ path: worktree.path, reason: "shared" })
      }
    })

  const mergedOnGitHub = (rootPath: string, branch: string) =>
    Effect.gen(function* () {
      const pullRequest = yield* github.branchPullRequest(rootPath, branch)
      if (pullRequest?.status !== "merged") return false
      const { head } = yield* github.pullRequestDetail(pullRequest.url)
      yield* git.run(rootPath, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, head])
      return true
    }).pipe(Effect.orElseSucceed(() => false))

  const deleteIfMerged = (rootPath: string, worktree: Worktree) =>
    Effect.gen(function* () {
      if (!(yield* branchExists(rootPath, worktree.branch))) return
      const merged =
        (yield* isMerged(rootPath, worktree.branch, worktree.baseRef)) ||
        (yield* mergedOnGitHub(rootPath, worktree.branch))
      // FIXME: `git branch -d` checks against the root checkout's HEAD, which may not be the base ref
      if (merged) yield* git.run(rootPath, ["branch", "-D", worktree.branch])
    })

  const pruneMergedBranches = (rootPath: string, projectId: string) =>
    Effect.gen(function* () {
      const all = (yield* findAll(undefined)).filter((worktree) => worktree.projectId === projectId)
      const live = all.filter((worktree) => worktree.status !== "removed")
      const inUse = new Set(live.flatMap((worktree) => [worktree.branch, worktree.baseRef]))
      const removed = new Map(
        all
          .filter((worktree) => worktree.status === "removed" && !inUse.has(worktree.branch))
          .map((worktree) => [worktree.branch, worktree]),
      )
      yield* Effect.forEach(removed.values(), (worktree) => Effect.ignore(deleteIfMerged(rootPath, worktree)), {
        discard: true,
      })
    })

  const deleteFiles = (rootPath: string, worktree: Worktree, deleteBranch: DeleteBranch) =>
    Effect.gen(function* () {
      if ((yield* registeredCheckouts(rootPath)).some((registered) => registered.path === worktree.path)) {
        // FIXME: only a second `--force` removes a locked checkout
        yield* git.run(rootPath, ["worktree", "remove", "--force", "--force", worktree.path])
      }
      yield* git.run(rootPath, ["worktree", "prune"])

      if (deleteBranch === "force" && (yield* branchExists(rootPath, worktree.branch))) {
        yield* git.run(rootPath, ["branch", "-D", worktree.branch])
      }
      if (deleteBranch !== "keep") yield* pruneMergedBranches(rootPath, worktree.projectId)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("worktree removal failed", cause).pipe(
          Effect.andThen(fs.exists(worktree.path)),
          Effect.flatMap((exists) => (exists ? setStatus(worktree.id, worktree.status) : Effect.void)),
        ),
      ),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => removals.delete(removalKey(worktree.projectId, worktree.branch)))),
    )

  const removeWhileExclusive = (id: string, deleteBranch: DeleteBranch, owner?: string) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      if (worktree.status === "removed") return worktree
      yield* ensureRemovable(worktree, owner)
      yield* stopSetup(id)
      const stopped = yield* get(id)
      const { rootPath } = yield* projects.get(worktree.projectId)
      const removed = yield* setStatus(id, "removed")
      const deletion = yield* Effect.forkDetach(deleteFiles(rootPath, stopped, deleteBranch))
      removals.set(removalKey(worktree.projectId, worktree.branch), deletion)
      return removed
    })

  const remove = (id: string, deleteBranch: DeleteBranch, owner?: string) =>
    exclusive(removeWhileExclusive(id, deleteBranch, owner))

  const checkoutOf = (worktree: Worktree) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(worktree.path)))
        return Option.some<WorktreeCheckout>({ id: worktree.id, state: "missing" })
      const status = yield* git.run(worktree.path, ["status", "--porcelain"])
      return Option.some<WorktreeCheckout>({ id: worktree.id, state: status.trim() === "" ? "clean" : "dirty" })
    }).pipe(Effect.orElseSucceed(Option.none<WorktreeCheckout>))

  const checkouts = findAll(undefined).pipe(
    Effect.mapError(persistence("worktrees.checkouts")),
    Effect.flatMap((all) =>
      Effect.forEach(
        all.filter((worktree) => worktree.status !== "removed"),
        checkoutOf,
        { concurrency: 8 },
      ),
    ),
    Effect.map((states) => states.flatMap(Option.toArray)),
  )

  const changes = (id: string) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      if (worktree.status === "removed") return null
      const mergeBase = (yield* git.run(worktree.path, ["merge-base", worktree.baseRef, "HEAD"])).trim()
      return yield* diffWorkingTree(worktree.path, mergeBase)
    }).pipe(Effect.provideContext(gitContext))

  const pullRequest = (id: string) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      const { rootPath } = yield* projects.get(worktree.projectId)
      return yield* github.branchPullRequest(rootPath, worktree.branch)
    })

  const currentBranch = (projectId: string) =>
    projects.get(projectId).pipe(
      Effect.flatMap(({ rootPath }) => git.run(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])),
      Effect.map((output) => output.trim()),
    )

  const branches = (projectId: string) =>
    projects.get(projectId).pipe(
      Effect.flatMap(({ rootPath }) =>
        git.run(rootPath, [
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname)",
          "refs/heads",
          "refs/remotes/origin",
        ]),
      ),
      Effect.map((output) => {
        const refs = output.split("\n").filter((ref) => ref !== "" && ref !== "refs/remotes/origin/HEAD")
        const local = refs.flatMap((ref) => (ref.startsWith("refs/heads/") ? [ref.slice("refs/heads/".length)] : []))
        const remote = refs.flatMap((ref) => {
          const name = ref.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length) : null
          return name === null || local.includes(name) ? [] : [`origin/${name}`]
        })
        return [...local, ...remote]
      }),
    )

  const defaultBranch = (projectId: string) =>
    projects.get(projectId).pipe(
      Effect.flatMap(({ rootPath }) =>
        git.run(rootPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).pipe(
          Effect.map((output) => output.trim()),
          Effect.orElseSucceed(() => "main"),
        ),
      ),
    )

  const fetch = (projectId: string) =>
    projects.get(projectId).pipe(
      Effect.flatMap(({ rootPath }) => git.remote(rootPath, ["fetch", "--quiet", "origin"])),
      Effect.asVoid,
    )

  return Worktrees.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("worktrees.list"))),
    checkouts,
    get,
    create,
    createFromPullRequest,
    checkout,
    checkoutPullRequest,
    remove,
    removeWhileExclusive,
    exclusive,
    changes,
    pullRequest,
    currentBranch,
    branches,
    defaultBranch,
    fetch,
    renameBranch,
    whenPrepared,
    stopSetup,
  })
})

export const layer = Layer.effect(Worktrees, make)
