import { homedir } from "node:os"
import { Effect, Option, Schema } from "effect"
import { Argument, Flag, GlobalFlag } from "effect/cli"
import type { Thread } from "../shared/domain.ts"
import type { Client } from "./client.ts"
import { EXIT, type ExitCode, exitWith } from "./exit.ts"
import { resolveProject } from "./projectRef.ts"
import { socketCandidates, connectFirst } from "./target.ts"
import { parseThreadRef, resolveThreadRef } from "./threadRef.ts"

export const DataDir = GlobalFlag.Setting("data")({
  flag: Flag.String("data").pipe(
    Flag.optional,
    Flag.withMetavar("dir"),
    Flag.withDescription("Data directory of the HinaCode to reach, or HINACODE_USER_DATA."),
  ),
})

export const threadArgument = Argument.String("thread").pipe(
  Argument.withDescription("A thread id, 4+ characters of one, or . for the thread whose worktree you are in."),
)

export const findProject = (client: Client, ref: string, cwd = process.cwd()) =>
  Effect.gen(function* () {
    const [projects, worktrees] = yield* Effect.all([
      client.call("projects.list", undefined),
      client.call("worktrees.list", undefined),
    ])
    return yield* Effect.fromResult(resolveProject(ref, projects, worktrees, cwd))
  })

export const withClient = <A, E, R>(use: (client: Client) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dataFlag = Option.getOrUndefined(yield* DataDir)
    const client = yield* connectFirst(socketCandidates({ dataFlag, env: process.env, home: homedir() }))
    return yield* use(client)
  }).pipe(Effect.scoped)

export const withThread = <A, E, R>(raw: string, use: (client: Client, thread: Thread) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const ref = yield* Effect.fromResult(parseThreadRef(raw))
    return yield* withClient((client) =>
      Effect.gen(function* () {
        const threads = yield* client.call("threads.list", undefined)
        const worktrees = ref.kind === "here" ? yield* client.call("worktrees.list", undefined) : []
        const thread = yield* Effect.fromResult(resolveThreadRef(ref, threads, worktrees, process.cwd()))
        return yield* use(client, thread)
      }),
    )
  })

export interface Output {
  readonly value: unknown
  readonly code: ExitCode
}

export const encode = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.orDie,
    Effect.map((encoded) => encoded ?? null),
  )

export const writeLine = (value: unknown) => Effect.sync(() => void process.stdout.write(`${JSON.stringify(value)}\n`))

export const emit = <E, R>(output: Effect.Effect<Output, E, R>) =>
  Effect.flatMap(output, ({ value, code }) => Effect.andThen(writeLine(value), exitWith(code)))

export const succeed = (value: unknown): Output => ({ value, code: EXIT.done })
