import { spawn } from "node:child_process"
import { stripVTControlCharacters } from "node:util"
import { Deferred, Duration, Effect, Option, Schema, Scope } from "effect"
import { Response } from "./protocol.ts"

export class PiCommandError extends Schema.TaggedError<PiCommandError>()("PiCommandError", {
  command: Schema.String,
  message: Schema.String,
}) {}

export class PiExit extends Schema.TaggedError<PiExit>()("PiExit", {
  message: Schema.String,
  output: Schema.String,
}) {}

export class PiTimeout extends Schema.TaggedError<PiTimeout>()("PiTimeout", {
  command: Schema.String,
  after: Schema.String,
}) {}

export type PiFailure = PiCommandError | PiExit | PiTimeout

export type Incoming =
  | { readonly kind: "event"; readonly event: unknown }
  | { readonly kind: "exit"; readonly error: PiExit }

export interface PiClient {
  readonly pid: () => number | undefined
  readonly isAlive: () => boolean
  readonly command: (
    type: string,
    fields?: object,
    timeout?: Duration.Duration | null,
  ) => Effect.Effect<unknown, PiFailure>
  readonly send: (message: object) => Effect.Effect<void>
  readonly subscribe: (listener: (message: Incoming) => void) => Effect.Effect<void, never, Scope.Scope>
}

const COMMAND_TIMEOUT = Duration.seconds(60)
const SHUTDOWN_GRACE = Duration.seconds(2)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeResponse = Schema.decodeUnknownOption(Response)

export const splitLines = (onLine: (line: string) => void) => {
  let buffered = ""
  return (chunk: string) => {
    buffered += chunk
    let end = buffered.indexOf("\n")
    while (end !== -1) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
      end = buffered.indexOf("\n")
    }
  }
}

export const makePiClient = (options: {
  readonly binaryPath: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(options.binaryPath, [...options.args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ),
      (proc) =>
        Effect.callback<void>((resume) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resume(Effect.void)
          proc.once("exit", () => resume(Effect.void))
          proc.stdin.end()
        }).pipe(
          Effect.timeoutOrElse({ duration: SHUTDOWN_GRACE, orElse: () => Effect.void }),
          Effect.ensuring(Effect.sync(() => proc.kill())),
        ),
    )

    const pending = new Map<
      string,
      { readonly command: string; readonly answer: Deferred.Deferred<unknown, PiFailure> }
    >()
    const listeners = new Set<(message: Incoming) => void>()
    let nextId = 1
    let exitError: PiExit | undefined
    let outputTail = ""

    const write = (message: object) => {
      if (exitError === undefined) child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const handleExit = (error: PiExit) => {
      if (exitError !== undefined) return
      exitError = error
      for (const { answer } of pending.values()) Deferred.doneUnsafe(answer, Effect.fail(error))
      pending.clear()
      for (const listener of listeners) listener({ kind: "exit", error })
    }

    child.on("error", (error) =>
      handleExit(new PiExit({ message: `pi failed to start: ${error.message}`, output: outputTail })),
    )
    child.on("close", (code, signal) => {
      const output = outputTail.trim()
      const reason = signal === null ? `code ${code}` : `signal ${signal}`
      handleExit(new PiExit({ message: `pi exited (${reason}).${output === "" ? "" : ` ${output}`}`, output }))
    })
    child.stdin.on("error", () => {})
    child.stderr.setEncoding("utf8")
    const keepOutput = (text: string) => {
      outputTail = (outputTail + stripVTControlCharacters(text)).slice(-2000)
    }
    child.stderr.on("data", keepOutput)

    const handleLine = (line: string) => {
      const parsed = decodeJson(line)
      if (Option.isNone(parsed)) return keepOutput(`${line}\n`)
      const response = decodeResponse(parsed.value)
      if (Option.isNone(response)) {
        for (const listener of listeners) listener({ kind: "event", event: parsed.value })
        return
      }
      const { id, success, data, error } = response.value
      const waiting = id === undefined ? undefined : pending.get(id)
      if (id === undefined || waiting === undefined) return
      pending.delete(id)
      Deferred.doneUnsafe(
        waiting.answer,
        success
          ? Effect.succeed(data)
          : Effect.fail(new PiCommandError({ command: waiting.command, message: error ?? "failed" })),
      )
    }
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", splitLines(handleLine))

    const command = (
      type: string,
      fields: object = {},
      timeout: Duration.Duration | null = COMMAND_TIMEOUT,
    ): Effect.Effect<unknown, PiFailure> =>
      Effect.suspend(() => {
        if (exitError !== undefined) return Effect.fail(exitError)
        const id = String(nextId++)
        const answer = Deferred.makeUnsafe<unknown, PiFailure>()
        pending.set(id, { command: type, answer })
        write({ ...fields, id, type })
        const awaited = Deferred.await(answer).pipe(Effect.onInterrupt(() => Effect.sync(() => pending.delete(id))))
        if (timeout === null) return awaited
        return awaited.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new PiTimeout({ command: type, after: Duration.format(timeout) })),
          }),
        )
      })

    const client: PiClient = {
      pid: () => child.pid,
      isAlive: () => exitError === undefined,
      command,
      send: (message) => Effect.sync(() => write(message)),
      subscribe: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(listener)
            if (exitError !== undefined) listener({ kind: "exit", error: exitError })
          }),
          () => Effect.sync(() => listeners.delete(listener)),
        ),
    }
    return client
  })
