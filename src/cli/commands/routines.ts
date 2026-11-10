import { Effect, Result, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { RpcMethods } from "../../shared/contract.ts"
import { Routine } from "../../shared/domain.ts"
import type { Client } from "../client.ts"
import { type CliFailure, usageError } from "../exit.ts"
import { emit, encode, succeed, withClient } from "../session.ts"

const ListedRoutine = Schema.Struct({ ...Routine.fields, machine: Schema.NullOr(Schema.String) })

const MIN_PREFIX = 4

export const resolveRoutine = (raw: string, routines: ReadonlyArray<Routine>): Result.Result<Routine, CliFailure> => {
  const ref = raw.toLowerCase()
  if (ref.length < MIN_PREFIX) return Result.fail(usageError(`pass ${MIN_PREFIX}+ characters of a routine id`))
  const matches = routines.filter((routine) => routine.id.startsWith(ref))
  if (matches.length === 1) return Result.succeed(matches[0]!)
  if (matches.length === 0) return Result.fail(usageError(`no routine starts with ${ref}`))
  return Result.fail(
    usageError(
      [
        `${ref} matches more than one routine:`,
        ...matches.map((routine) => `  ${routine.id.slice(0, 8)}  ${routine.name}`),
      ].join("\n"),
    ),
  )
}

const withRoutine = <A, E, R>(raw: string, use: (client: Client, routine: Routine) => Effect.Effect<A, E, R>) =>
  withClient((client) =>
    Effect.gen(function* () {
      const routine = yield* Effect.fromResult(resolveRoutine(raw, yield* client.call("routines.list", undefined)))
      return yield* use(client, routine)
    }),
  )

const routineArgument = Argument.String("routine").pipe(
  Argument.withDescription(`A routine id, or ${MIN_PREFIX}+ characters of it.`),
)

const ls = Command.make("ls", {}, () =>
  emit(
    withClient((client) =>
      Effect.gen(function* () {
        const [routines, machines] = yield* Effect.all([
          client.call("routines.list", undefined),
          client.call("machines.list", undefined),
        ])
        const listed = routines.map((routine) => ({
          ...routine,
          machine: machines.find((machine) => machine.projectIds.includes(routine.projectId))?.name ?? null,
        }))
        return succeed(yield* encode(Schema.Array(ListedRoutine), listed))
      }),
    ),
  ),
).pipe(Command.withDescription("List routines on every machine, as JSON."))

const run = Command.make("run", { routine: routineArgument }, (args) =>
  emit(
    withRoutine(args.routine, (client, routine) =>
      Effect.gen(function* () {
        const started = yield* client.call("routines.run", { id: routine.id })
        return succeed(yield* encode(RpcMethods["routines.run"].response, started))
      }),
    ),
  ),
).pipe(Command.withDescription("Run a routine now, whether or not it is enabled."))

const setEnabled = (name: "enable" | "disable", enabled: boolean, description: string) =>
  Command.make(name, { routine: routineArgument }, (args) =>
    emit(
      withRoutine(args.routine, (client, routine) =>
        Effect.gen(function* () {
          const updated = yield* client.call("routines.update", { id: routine.id, enabled })
          return succeed(yield* encode(Routine, updated))
        }),
      ),
    ),
  ).pipe(Command.withDescription(description))

export const routines = Command.make("routines").pipe(
  Command.withDescription("List, run, enable and disable routines."),
  Command.withSubcommands([
    ls,
    run,
    setEnabled("enable", true, "Enable a routine and schedule its next run."),
    setEnabled("disable", false, "Disable a routine. Its webhook answers 409 until it is enabled again."),
  ]),
)
