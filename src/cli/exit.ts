import { Data, Effect } from "effect"
import { errorExitCode, errorReported } from "effect/Runtime"

export const EXIT = {
  done: 0,
  failed: 1,
  needsHuman: 2,
  limited: 3,
  unreachable: 4,
  usage: 64,
} as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export class CliFailure extends Data.TaggedError("CliFailure")<{ readonly code: ExitCode; readonly message: string }> {
  override get [errorExitCode]() {
    return this.code
  }
  override readonly [errorReported] = false
}

export const usageError = (message: string) => new CliFailure({ code: EXIT.usage, message })

export const unreachableError = (message: string) => new CliFailure({ code: EXIT.unreachable, message })

export const exitWith = (code: ExitCode, message = "") =>
  code === EXIT.done ? Effect.void : Effect.fail(new CliFailure({ code, message }))
