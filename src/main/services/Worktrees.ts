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
  type WorktreeStatus,
} from "../../shared/domain.ts"
import { nowIso } from "./clock.ts"
import { NotFoundError, type PersistenceError, persistence, WorktreeBusyError, WorktreeTakenError } from "./errors.ts"
import { Events } from "./Events.ts"
import { type CommandError, Git } from "./Git.ts"
import { GitHub, type GitHubError, type PullRequestHead } from "./GitHub.ts"
import { Projects } from "./Projects.ts"
import { diffWorkingTree } from "./workingTree.ts"

export interface CreateWorktree {
  readonly projectId: string
  readonly branch: string
  readonly baseRef: string
  /** Where a branch that does not exist yet starts. Defaults to `baseRef`. */
  readonly startPoint?: string
}

/** `ifMerged` deletes the branch only when it is fully merged into the worktree's base ref. */
export type DeleteBranch = "keep" | "ifMerged" | "force"

type Failure = PersistenceError | NotFoundError | CommandError

export class Worktrees extends Context.Service<
  Worktrees,
  {
    readonly list: Effect.Effect<ReadonlyArray<Worktree>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Worktree, PersistenceError | NotFoundError>
    /**
     * Adds the git worktree and returns it in `preparing`, then runs the project's setup script in the
     * background, streaming `worktree.setupLog` and ending in `ready` or `failed`.
     * A branch has at most one live worktree: asking for it again fails with `WorktreeTakenError`.
     */
    readonly create: (input: CreateWorktree) => Effect.Effect<Worktree, Failure | WorktreeTakenError>
    /**
     * Like `create`, on the pull request's head fetched from `origin`. A branch of the same repository keeps
     * its name and tracks `origin`, so pushing updates the pull request. A fork's head has no branch on
     * `origin`, so it lands on a local `kk/pr-<number>` branch.
     */
    readonly createFromPullRequest: (
      projectId: string,
      head: PullRequestHead,
    ) => Effect.Effect<Worktree, Failure | WorktreeTakenError>
    /**
     * Marks the worktree removed and returns at once; the checkout and (per `deleteBranch`) the
     * branch are deleted in the background, so a large tree does not hold up the caller.
     * Refuses while its setup script or a turn of a thread using it runs.
     * `owner` is the thread giving the worktree up, and any other open thread using it also blocks
     * removal. Without `owner` the caller speaks for every thread, as when deleting the project.
     */
    readonly remove: (
      id: string,
      deleteBranch: DeleteBranch,
      owner?: string,
    ) => Effect.Effect<Worktree, Failure | WorktreeBusyError>
    /** `remove` for a caller already inside `exclusive`, which is not reentrant. */
    readonly removeWhileExclusive: (
      id: string,
      deleteBranch: DeleteBranch,
      owner?: string,
    ) => Effect.Effect<Worktree, Failure | WorktreeBusyError>
    /**
     * Runs `effect` while no worktree is being created or removed. A turn resolves its working
     * directory and marks its thread running inside this, so a removal cannot slip in between.
     */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    /** Renames the worktree's branch in place; its checkout path keeps the old name. */
    readonly renameBranch: (id: string, branch: string) => Effect.Effect<Worktree, Failure>
    /** Everything the worktree changed since it forked from its base ref, or null once it is removed. */
    readonly changes: (id: string) => Effect.Effect<Changes | null, Failure | PlatformError.PlatformError>
    /** The branch's GitHub pull request, or null when there is none. */
    readonly pullRequest: (
      id: string,
    ) => Effect.Effect<PullRequest | null, PersistenceError | NotFoundError | GitHubError | Schema.SchemaError>
    readonly currentBranch: (projectId: string) => Effect.Effect<string, Failure>
    /** Local branches, most recently committed first, then `origin/*` branches that have no local copy. */
    readonly branches: (projectId: string) => Effect.Effect<ReadonlyArray<string>, Failure>
    /** `origin`'s default branch, or `main` when the checkout does not know it. */
    readonly defaultBranch: (projectId: string) => Effect.Effect<string, PersistenceError | NotFoundError>
  }
>()("kkcode/Worktrees") {}

const checkoutsDir = (rootPath: string) => join(dirname(rootPath), ".kkcode-worktrees", basename(rootPath))

// The id suffix keeps branches like `kk/fix` and `kk-fix` apart, and gives every row its own path.
const checkoutPath = (rootPath: string, branch: string, id: string) =>
  join(checkoutsDir(rootPath), `${branch.replaceAll("/", "-")}-${id.slice(0, 8)}`)

const removalKey = (projectId: string, branch: string) => `${projectId}\0${branch}`

/** Parses `git worktree list --porcelain -z`: NUL-separated attribute lines, an empty field between checkouts. */
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
  const findUsers = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, status: ThreadStatus }),
    execute: (worktreeId) => sql`SELECT id, status FROM thread WHERE worktree_id = ${worktreeId}`,
  })

  // Setup scripts run in this process, so a row still preparing at boot lost its script to a quit or
  // crash. Rerunning an arbitrary script unasked is not safe, so it ends as failed like any other.
  yield* sql`
    UPDATE worktree SET status = 'failed', setup_log = setup_log || ${"\nSetup was interrupted when kkcode quit.\n"}
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
      // A base ref that no longer exists cannot prove the branch merged.
      Effect.orElseSucceed(() => false),
    )

  const runSetupScript = (worktree: Worktree, project: Project, script: string) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.env["SHELL"] || "/bin/sh", ["-lc", script], {
          cwd: worktree.path,
          env: {
            KKCODE_ROOT_PATH: project.rootPath,
            KKCODE_WORKTREE_PATH: worktree.path,
            KKCODE_BRANCH: worktree.branch,
          },
          extendEnv: true,
          stdin: "ignore",
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
    )

  /**
   * Deletions still running, by project and branch, so a create of the same branch waits for the old
   * checkout to let go of it.
   */
  const removals = new Map<string, Fiber.Fiber<void>>()

  /**
   * A checkout of `branch` in this project's checkouts dir that no row records was left by a crash
   * between `git worktree add` and the insert, so it is safe to adopt.
   */
  const findOrphan = (rootPath: string, branch: string) =>
    Effect.gen(function* () {
      const checkout = (yield* registeredCheckouts(rootPath)).find(
        ({ path, ref }) => ref === `refs/heads/${branch}` && dirname(path) === checkoutsDir(rootPath),
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

      const id = randomUUID()
      const orphan = yield* findOrphan(project.rootPath, input.branch)
      const path = Option.getOrElse(orphan, () => checkoutPath(project.rootPath, input.branch, id))
      if (Option.isNone(orphan)) {
        const args = (yield* branchExists(project.rootPath, input.branch))
          ? ["worktree", "add", path, input.branch]
          : ["worktree", "add", "-b", input.branch, path, input.startPoint ?? input.baseRef]
        yield* git.run(project.rootPath, args)
      }

      const worktree: Worktree = {
        id,
        projectId: project.id,
        path,
        branch: input.branch,
        baseRef: input.baseRef,
        status: "preparing",
        setupLog: "",
        createdAt: yield* nowIso,
      }
      yield* sql`INSERT INTO worktree ${sql.insert(worktree)}`.pipe(Effect.mapError(persistence("worktrees.create")))
      yield* events.publish({ type: "worktree.updated", worktree })
      yield* Effect.forkDetach(setup(worktree, project))
      return worktree
    }).pipe(exclusive)

  const createFromPullRequest = (projectId: string, head: PullRequestHead) =>
    Effect.gen(function* () {
      const { rootPath } = yield* projects.get(projectId)
      const [branch, source, fetched] = head.isCrossRepository
        ? [`kk/pr-${head.number}`, `refs/pull/${head.number}/head`, `refs/kkcode/pull/${head.number}`]
        : [head.headRefName, `refs/heads/${head.headRefName}`, `refs/remotes/origin/${head.headRefName}`]
      yield* git.run(rootPath, ["fetch", "--quiet", "origin", `+${source}:${fetched}`])
      return yield* create({ projectId, branch, baseRef: head.baseRefName, startPoint: fetched })
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
      if (worktree.status === "preparing") {
        return yield* new WorktreeBusyError({ path: worktree.path, reason: "setup" })
      }
      const users = yield* findUsers(worktree.id).pipe(Effect.mapError(persistence("worktrees.remove")))
      if (users.some((thread) => isThreadBusy(thread.status))) {
        return yield* new WorktreeBusyError({ path: worktree.path, reason: "turn" })
      }
      const othersOpen = users.some((thread) => thread.id !== owner && thread.status !== "archived")
      if (owner !== undefined && othersOpen) {
        return yield* new WorktreeBusyError({ path: worktree.path, reason: "shared" })
      }
    })

  const deleteFiles = (rootPath: string, worktree: Worktree, deleteBranch: DeleteBranch) =>
    Effect.gen(function* () {
      if ((yield* registeredCheckouts(rootPath)).some((checkout) => checkout.path === worktree.path)) {
        yield* git.run(rootPath, ["worktree", "remove", "--force", worktree.path])
      }
      yield* git.run(rootPath, ["worktree", "prune"])

      if (deleteBranch !== "keep" && (yield* branchExists(rootPath, worktree.branch))) {
        // `-D` even when merged: `-d` checks against the root checkout's HEAD, which may not be the base ref.
        const shouldDelete = deleteBranch === "force" || (yield* isMerged(rootPath, worktree.branch, worktree.baseRef))
        if (shouldDelete) yield* git.run(rootPath, ["branch", "-D", worktree.branch])
      }
    }).pipe(
      // The row already says removed; put it back so the user can retry instead of losing the checkout.
      Effect.catchCause((cause) =>
        Effect.logError("worktree removal failed", cause).pipe(Effect.andThen(setStatus(worktree.id, worktree.status))),
      ),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => removals.delete(removalKey(worktree.projectId, worktree.branch)))),
    )

  const removeWhileExclusive = (id: string, deleteBranch: DeleteBranch, owner?: string) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      if (worktree.status === "removed") return worktree
      yield* ensureRemovable(worktree, owner)
      const { rootPath } = yield* projects.get(worktree.projectId)
      const removed = yield* setStatus(id, "removed")
      const deletion = yield* Effect.forkDetach(deleteFiles(rootPath, worktree, deleteBranch))
      removals.set(removalKey(worktree.projectId, worktree.branch), deletion)
      return removed
    })

  const remove = (id: string, deleteBranch: DeleteBranch, owner?: string) =>
    exclusive(removeWhileExclusive(id, deleteBranch, owner))

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
          Effect.map((output) => output.trim().replace(/^origin\//, "")),
          Effect.orElseSucceed(() => "main"),
        ),
      ),
    )

  return Worktrees.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("worktrees.list"))),
    get,
    create,
    createFromPullRequest,
    remove,
    removeWhileExclusive,
    exclusive,
    changes,
    pullRequest,
    currentBranch,
    branches,
    defaultBranch,
    renameBranch,
  })
})

export const layer = Layer.effect(Worktrees, make)
