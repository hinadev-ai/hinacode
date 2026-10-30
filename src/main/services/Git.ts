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
  readonly okExitCodes?: ReadonlyArray<number>
  readonly env?: Record<string, string>
}

// FIXME: authenticate through gh, since macOS's osxkeychain helper opens a Keychain dialog over the app
export const REMOTE_GIT_ARGS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
export const REMOTE_GIT_ENV = { GIT_TERMINAL_PROMPT: "0" }

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
      Effect.withSpan(`exec ${command}`, { attributes: { command: [command, ...args].join(" ") } }),
    )

const toChangedStatus = (letter: string): ChangedFileStatus => {
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  if (letter === "U") return "conflict"
  return "modified"
}

export const parseNameStatus = (output: string) => {
  const fields = output.split("\0").filter(Boolean)
  const files: Array<{ path: string; status: ChangedFileStatus }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    files.push({ path: fields[i + 1] ?? "", status: toChangedStatus(fields[i]?.charAt(0) ?? "") })
  }
  return files
}

const LOG_FIELDS = ["%H", "%P", "%an", "%ad", "%D", "%s"]
export const LOG_FORMAT = LOG_FIELDS.join("%x00")

const parseRefs = (decorations: string) =>
  decorations === "" ? [] : decorations.split(", ").flatMap((ref) => ref.split(" -> "))

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
    readonly run: (
      cwd: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<string, CommandError>
    readonly remote: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, CommandError>
    readonly log: (cwd: string, limit: number) => Effect.Effect<Array<GitCommit>, CommandError>
    readonly show: (cwd: string, hash: string) => Effect.Effect<CommitDiff, CommandError>
  }
>()("hinacode/Git") {}

const make = Effect.gen(function* () {
  const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)
  const run = (cwd: string, args: ReadonlyArray<string>, options?: RunOptions) =>
    exec("git", ["-C", cwd, ...args], cwd, options)
  const remote = (cwd: string, args: ReadonlyArray<string>) =>
    run(cwd, [...REMOTE_GIT_ARGS, ...args], { env: REMOTE_GIT_ENV })

  // FIXME: `--all` also walks the stash and tool-private refs such as editor checkpoints
  const log = (cwd: string, limit: number) =>
    run(cwd, [
      "log",
      "--branches",
      "--remotes",
      "--tags",
      "HEAD",
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
    const diff = (args: ReadonlyArray<string>) =>
      run(cwd, [
        "-c",
        "core.quotePath=false",
        "show",
        "--format=",
        "--diff-merges=first-parent",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        ...args,
        hash,
        "--",
      ])
    return Effect.all({
      patch: diff(["--patch"]),
      files: diff(["--name-status", "-z"]).pipe(Effect.map(parseNameStatus)),
    })
  }

  return Git.of({ run, remote, log, show })
})

export const layer = Layer.effect(Git, make)
