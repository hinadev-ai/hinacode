import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Effect, Exit } from "effect"
import { CliConfig, CliError, Command, GlobalFlag } from "effect/cli"
import { getErrorExitCode } from "effect/Runtime"
import packageJson from "../../package.json" with { type: "json" }
import { inbox } from "./commands/inbox.ts"
import { routines } from "./commands/routines.ts"
import { run } from "./commands/run.ts"
import { watch } from "./commands/watch.ts"
import { threadCommands } from "./commands.ts"
import { CliFailure, EXIT } from "./exit.ts"
import { RpcError } from "./client.ts"
import { cloudCommands } from "./serve.ts"
import { DataDir } from "./session.ts"

const { version } = packageJson

const hinacode = Command.make("hinacode").pipe(
  Command.withDescription(
    "Drive the agents HinaCode runs on every machine you reach, from scripts and other programs. Every command prints one JSON document on stdout, except watch, which prints one JSON line per event.",
  ),
  Command.withSubcommands([run, ...threadCommands, inbox, watch, routines, ...cloudCommands]),
  Command.withGlobalFlags([DataDir]),
)

const exitCode = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return EXIT.done
  const error = Cause.squash(exit.cause)
  if (CliError.isCliError(error) && error._tag === "ShowHelp") return error.errors.length > 0 ? EXIT.usage : EXIT.done
  if (CliError.isCliError(error)) return EXIT.usage
  return getErrorExitCode(error)
}

Command.run(hinacode, { version }).pipe(
  Effect.tapError((error) =>
    (error instanceof CliFailure && error.message !== "") || error instanceof RpcError
      ? Effect.sync(() => process.stderr.write(`hinacode: ${error.message}\n`))
      : Effect.void,
  ),
  Effect.provide([
    NodeServices.layer,
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] }),
  ]),
  NodeRuntime.runMain({ teardown: (exit, onExit) => onExit(exitCode(exit)) }),
)
