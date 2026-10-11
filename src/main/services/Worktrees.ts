import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient, SqlSchema } from "effect/sql"
import {
  type ChangedFileStatus,
  type Project,
  PullRequestState,
  Worktree,
  type WorktreeChanges,
  type WorktreeStatus,
} from "../../shared/domain.ts"
import { nowIso } from "./clock.ts"
import { NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import { Events } from "./Events.ts"
import { type CommandError, Git } from "./Git.ts"
import { Projects } from "./Projects.ts"

export interface CreateWorktree {
  readonly projectId: string
  readonly branch: string
  readonly baseRef: string
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
     * Creating the same branch twice returns the existing worktree.
     */
    readonly create: (input: CreateWorktree) => Effect.Effect<Worktree, Failure>
    readonly remove: (id: string, deleteBranch: DeleteBranch) => Effect.Effect<Worktree, Failure>
    readonly changes: (id: string) => Effect.Effect<WorktreeChanges, Failure>
    /** The branch's GitHub pull request, or null when there is none or `gh` is unavailable. */
    readonly pullRequest: (id: string) => Effect.Effect<PullRequestState | null, PersistenceError | NotFoundError>
    readonly currentBranch: (projectId: string) => Effect.Effect<string, Failure>
  }
>()("kkcode/Worktrees") {}

export const worktreePath = (rootPath: string, branch: string) =>
  join(dirname(rootPath), ".kkcode-worktrees", basename(rootPath), branch.replaceAll("/", "-"))

const toChangedStatus = (letter: string): ChangedFileStatus => {
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  return "modified"
}

/** Parses `git diff --name-status -z`: alternating status letter and path. */
const parseNameStatus = (output: string) => {
  const fields = output.split("\0").filter(Boolean)
  const files: Array<{ path: string; status: ChangedFileStatus }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    files.push({ path: fields[i + 1] ?? "", status: toChangedStatus(fields[i]?.charAt(0) ?? "") })
  }
  return files
}

const decodePullRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestState))

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const git = yield* Git
  const events = yield* Events
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

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
  const findByPath = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Worktree,
    execute: (path) => sql`SELECT * FROM worktree WHERE path = ${path}`,
  })

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

  const registeredPaths = (rootPath: string) =>
    git.run(rootPath, ["worktree", "list", "--porcelain", "-z"]).pipe(
      Effect.map(
        (output) =>
          new Set(
            output
              .split("\0")
              .filter((field) => field.startsWith("worktree "))
              .map((field) => field.slice("worktree ".length)),
          ),
      ),
    )

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

  const create = (input: CreateWorktree) =>
    Effect.gen(function* () {
      const project = yield* projects.get(input.projectId)
      const path = worktreePath(project.rootPath, input.branch)
      const existing = yield* findByPath(path).pipe(Effect.mapError(persistence("worktrees.create")))
      if (Option.isSome(existing) && existing.value.status !== "removed") return existing.value

      // Adopt a checkout left behind by a crash between `git worktree add` and the insert.
      if (!(yield* registeredPaths(project.rootPath)).has(path)) {
        const args = (yield* branchExists(project.rootPath, input.branch))
          ? ["worktree", "add", path, input.branch]
          : ["worktree", "add", "-b", input.branch, path, input.baseRef]
        yield* git.run(project.rootPath, args)
      }

      const now = yield* nowIso
      const worktree: Worktree = Option.match(existing, {
        onNone: () => ({
          id: randomUUID(),
          projectId: project.id,
          path,
          branch: input.branch,
          baseRef: input.baseRef,
          status: "preparing" as const,
          setupLog: "",
          createdAt: now,
        }),
        // The path is unique, so recreating a removed worktree revives its row.
        onSome: (row) => ({ ...row, baseRef: input.baseRef, status: "preparing" as const, setupLog: "" }),
      })
      if (Option.isSome(existing)) {
        yield* sql`
          UPDATE worktree SET base_ref = ${worktree.baseRef}, status = ${worktree.status}, setup_log = ''
          WHERE id = ${worktree.id}
        `.pipe(Effect.mapError(persistence("worktrees.create")))
      } else {
        yield* sql`INSERT INTO worktree ${sql.insert(worktree)}`.pipe(Effect.mapError(persistence("worktrees.create")))
      }
      yield* events.publish({ type: "worktree.updated", worktree })
      yield* Effect.forkDetach(setup(worktree, project))
      return worktree
    })

  const remove = (id: string, deleteBranch: DeleteBranch) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      const { rootPath } = yield* projects.get(worktree.projectId)

      if ((yield* registeredPaths(rootPath)).has(worktree.path)) {
        yield* git.run(rootPath, ["worktree", "remove", "--force", worktree.path])
      }
      yield* git.run(rootPath, ["worktree", "prune"])

      if (deleteBranch !== "keep" && (yield* branchExists(rootPath, worktree.branch))) {
        // `-D` even when merged: `-d` checks against the root checkout's HEAD, which may not be the base ref.
        const shouldDelete = deleteBranch === "force" || (yield* isMerged(rootPath, worktree.branch, worktree.baseRef))
        if (shouldDelete) yield* git.run(rootPath, ["branch", "-D", worktree.branch])
      }

      return yield* setStatus(id, "removed")
    })

  const changes = (id: string) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      if (worktree.status === "removed") return { baseRef: worktree.baseRef, files: [], patch: "" }

      const cwd = worktree.path
      const mergeBase = (yield* git.run(cwd, ["merge-base", worktree.baseRef, "HEAD"])).trim()
      // Diffing the merge base against the working tree covers both commits and uncommitted edits.
      const tracked = parseNameStatus(yield* git.run(cwd, ["diff", "--no-renames", "--name-status", "-z", mergeBase]))
      const trackedPatch = yield* git.run(cwd, ["diff", "--no-renames", mergeBase])
      const untracked = (yield* git.run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean)
      const untrackedPatches = yield* Effect.forEach(untracked, (path) =>
        git.run(cwd, ["diff", "--no-index", "--", "/dev/null", path], { okExitCodes: [1] }),
      )

      return {
        baseRef: worktree.baseRef,
        files: [...tracked, ...untracked.map((path) => ({ path, status: "untracked" as const }))],
        patch: [trackedPatch, ...untrackedPatches].join(""),
      }
    })

  const pullRequest = (id: string) =>
    Effect.gen(function* () {
      const worktree = yield* get(id)
      const { rootPath } = yield* projects.get(worktree.projectId)
      return yield* git.gh(rootPath, ["pr", "view", worktree.branch, "--json", "state,url"]).pipe(
        Effect.flatMap(decodePullRequest),
        Effect.orElseSucceed(() => null),
      )
    })

  const currentBranch = (projectId: string) =>
    projects.get(projectId).pipe(
      Effect.flatMap(({ rootPath }) => git.run(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])),
      Effect.map((output) => output.trim()),
    )

  return Worktrees.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("worktrees.list"))),
    get,
    create,
    remove,
    changes,
    pullRequest,
    currentBranch,
  })
})

export const layer = Layer.effect(Worktrees, make)
