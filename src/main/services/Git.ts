import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { ChangedFileStatus, CommitDiff, GitCommit } from "../../shared/domain.ts"

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {
  override get message(): string {
    const detail = this.stderr.trim() || `exit code ${this.exitCode}`
    return `${this.command} ${this.args.join(" ")} failed: ${detail}`
  }
}

export interface RunOptions {
  /** Exit codes treated as success besides 0, e.g. 1 for `git rev-parse --verify --quiet` on a missing ref. */
  readonly okExitCodes?: ReadonlyArray<number>
  /** Added to the inherited environment. */
  readonly env?: Record<string, string>
}

/** Runs `command` in `cwd` and returns stdout. A command that cannot start fails with exit code -1. */
export const makeExec =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (command: string, args: ReadonlyArray<string>, cwd: string, options?: RunOptions) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, stdin: "ignore", env: options?.env, extendEnv: true }),
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      if (exitCode !== 0 && !options?.okExitCodes?.includes(exitCode)) {
        return yield* new CommandError({ command, args, exitCode, stderr })
      }
      return stdout
    }).pipe(
      Effect.scoped,
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(new CommandError({ command, args, exitCode: -1, stderr: cause.message })),
      ),
    )

const toChangedStatus = (letter: string): ChangedFileStatus => {
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  if (letter === "U") return "conflict"
  return "modified"
}

/** Parses `git diff --name-status -z`: alternating status letter and path. */
export const parseNameStatus = (output: string) => {
  const fields = output.split("\0").filter(Boolean)
  const files: Array<{ path: string; status: ChangedFileStatus }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    files.push({ path: fields[i + 1] ?? "", status: toChangedStatus(fields[i]?.charAt(0) ?? "") })
  }
  return files
}

/**
 * Pins patch output against user config (color, mnemonic or missing prefixes, an external differ) so a parser
 * finds each file by its `a/… b/…` header.
 */
export const PATCH_FLAGS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]

export const UNQUOTED_PATHS = ["-c", "core.quotePath=false"]

const LOG_FIELDS = ["%H", "%P", "%an", "%ad", "%D", "%s"]
export const LOG_FORMAT = LOG_FIELDS.join("%x00")

/** `HEAD -> main, origin/main, tag: v1` becomes `HEAD`, `main`, `origin/main`, `tag: v1`. */
const parseRefs = (decorations: string) =>
  decorations === "" ? [] : decorations.split(", ").flatMap((ref) => ref.split(" -> "))

/** Parses `git log -z --format=<LOG_FORMAT>`: every field and every commit ends at a NUL. */
export const parseLog = (output: string): Array<GitCommit> => {
  const fields = output.split("\0")
  const commits: Array<GitCommit> = []
  for (let i = 0; i + LOG_FIELDS.length <= fields.length; i += LOG_FIELDS.length) {
    const [hash = "", parents = "", author = "", authoredAt = "", refs = "", subject = ""] = fields.slice(
      i,
      i + LOG_FIELDS.length,
    )
    commits.push({
      hash,
      parents: parents === "" ? [] : parents.split(" "),
      subject,
      author,
      authoredAt,
      refs: parseRefs(refs),
    })
  }
  return commits
}

export class Git extends Context.Service<
  Git,
  {
    /** Runs `git -C cwd ...args` and returns stdout. */
    readonly run: (
      cwd: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<string, CommandError>
    /** Up to `limit` commits reachable from branches, remote branches, tags and HEAD, children before parents. */
    readonly log: (cwd: string, limit: number) => Effect.Effect<Array<GitCommit>, CommandError>
    /** The commit's changes against its first parent. `hash` must already be validated as hex. */
    readonly show: (cwd: string, hash: string) => Effect.Effect<CommitDiff, CommandError>
  }
>()("kkcode/Git") {}

const make = Effect.gen(function* () {
  const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)
  const run = (cwd: string, args: ReadonlyArray<string>, options?: RunOptions) =>
    exec("git", ["-C", cwd, ...args], cwd, options)

  // Not `--all`: that also walks the stash and tool-private refs such as editor checkpoints,
  // which show up as disconnected lanes that are not history.
  const log = (cwd: string, limit: number) =>
    run(cwd, [
      "log",
      "--branches",
      "--remotes",
      "--tags",
      "HEAD",
      // An unborn HEAD in a repository without commits is skipped instead of failing.
      "--ignore-missing",
      "--decorate-refs=refs/heads/",
      "--decorate-refs=refs/remotes/",
      "--decorate-refs=refs/tags/",
      "--decorate-refs=HEAD",
      "--topo-order",
      "--date=iso-strict",
      "--no-color",
      "-z",
      `--max-count=${limit}`,
      `--format=${LOG_FORMAT}`,
      "--",
    ]).pipe(Effect.map(parseLog))

  const show = (cwd: string, hash: string) => {
    const diffAgainstFirstParent = (args: ReadonlyArray<string>) =>
      run(cwd, [
        ...UNQUOTED_PATHS,
        "show",
        "--format=",
        "--diff-merges=first-parent",
        "--no-renames",
        ...PATCH_FLAGS,
        ...args,
        hash,
        "--",
      ])
    return Effect.all({
      patch: diffAgainstFirstParent(["--patch"]),
      files: diffAgainstFirstParent(["--name-status", "-z"]).pipe(Effect.map(parseNameStatus)),
    })
  }

  return Git.of({ run, log, show })
})

export const layer = Layer.effect(Git, make)
