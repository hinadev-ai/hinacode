import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

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
  /** Exit codes treated as success besides 0, e.g. 1 for `git diff --no-index` when files differ. */
  readonly okExitCodes?: ReadonlyArray<number>
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
    /** Runs the GitHub CLI in `cwd`. Fails with exit code -1 when `gh` is not installed. */
    readonly gh: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, CommandError>
  }
>()("kkcode/Git") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const exec = (command: string, args: ReadonlyArray<string>, cwd: string, options?: RunOptions) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, stdin: "ignore" }))
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

  return Git.of({
    run: (cwd, args, options) => exec("git", ["-C", cwd, ...args], cwd, options),
    gh: (cwd, args) => exec("gh", args, cwd),
  })
})

export const layer = Layer.effect(Git, make)
