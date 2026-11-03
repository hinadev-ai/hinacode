import { text as readText } from "node:stream/consumers"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { methodKind, type RpcMethod, RpcMethods } from "../shared/contract.ts"
import { isThreadBusy, type Machine, Thread, ThreadStatus } from "../shared/domain.ts"
import type { Client } from "./client.ts"
import { usageError } from "./exit.ts"
import { awaitOutcome } from "./outcome.ts"
import { emit, encode, findProject, succeed, threadArgument, withClient, withThread } from "./session.ts"

const ListedThread = Schema.Struct({ ...Thread.fields, machine: Schema.NullOr(Schema.String) })

const machineOf = (thread: Thread, machines: ReadonlyArray<Machine>) =>
  machines.find((machine) => machine.projectIds.includes(thread.projectId))

const isRpcMethod = (method: string): method is RpcMethod => Object.hasOwn(RpcMethods, method)

const parseJson = (text: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => usageError(`the payload is not JSON: ${text}`),
  })

const callAny = (method: RpcMethod, rawPayload: string | undefined) =>
  withClient((client) =>
    Effect.gen(function* () {
      const spec = RpcMethods[method]
      const raw = rawPayload === undefined ? undefined : yield* parseJson(rawPayload)
      const payload = yield* Schema.decodeUnknownEffect(spec.request)(raw).pipe(
        Effect.mapError((error) => usageError(`${method}: ${error.message}`)),
      )
      return succeed(yield* encode(spec.response, yield* client.call(method, payload)))
    }),
  )

const rpc = Command.make(
  "rpc",
  {
    method: Argument.String("method").pipe(
      Argument.withDescription("An rpc method, such as threads.list."),
      Argument.optional,
    ),
    payload: Argument.String("json").pipe(
      Argument.withDescription("The request payload as JSON, or - to read it from stdin."),
      Argument.optional,
    ),
    list: Flag.Boolean("list").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print every rpc method and whether it is a read or a mutation."),
    ),
  },
  ({ method, payload, list }) => {
    if (list) return emit(Effect.succeed(succeed(methodKind)))
    if (Option.isNone(method)) return Effect.fail(usageError("pass an rpc method, or --list to see them"))
    const name = method.value
    if (!isRpcMethod(name)) {
      return Effect.fail(usageError(`unknown rpc method ${name}. Run hinacode rpc --list to see them.`))
    }
    const json = Option.getOrUndefined(payload)
    const body = json === "-" ? Effect.promise(() => readText(process.stdin)) : Effect.succeed(json)
    return emit(Effect.flatMap(body, (raw) => callAny(name, raw)))
  },
).pipe(Command.withDescription("Call any rpc method. The payload is checked against its request schema."))

const ls = Command.make(
  "ls",
  {
    project: Flag.String("project").pipe(
      Flag.withMetavar("id|path|."),
      Flag.withDescription("Only threads of this project: an id, a path inside it, or . for the current directory."),
      Flag.optional,
    ),
    machine: Flag.String("machine").pipe(
      Flag.withMetavar("name"),
      Flag.withDescription("Only threads on this machine."),
      Flag.optional,
    ),
    status: Flag.Literals("status", ThreadStatus.literals).pipe(
      Flag.withMetavar("status"),
      Flag.withDescription("Only threads with this status. Archived threads show only when asked for."),
      Flag.optional,
    ),
  },
  (flags) =>
    emit(
      withClient((client) =>
        Effect.gen(function* () {
          const [threads, machines] = yield* Effect.all([
            client.call("threads.list", undefined),
            client.call("machines.list", undefined),
          ])
          const projectRef = Option.getOrUndefined(flags.project)
          const project = projectRef === undefined ? undefined : yield* findProject(client, projectRef)
          const machine = Option.getOrUndefined(flags.machine)?.toLowerCase()
          const status = Option.getOrUndefined(flags.status)
          const shown = threads
            .map((thread) => ({ ...thread, machine: machineOf(thread, machines)?.name ?? null }))
            .filter(
              (thread) =>
                (status === undefined ? thread.status !== "archived" : thread.status === status) &&
                (project === undefined || thread.projectId === project.id) &&
                (machine === undefined || thread.machine?.toLowerCase() === machine),
            )
          return succeed(yield* encode(Schema.Array(ListedThread), shown))
        }),
      ),
    ),
).pipe(Command.withDescription("List threads on every machine, as JSON."))

const machines = Command.make("machines", {}, () => emit(callAny("machines.list", undefined))).pipe(
  Command.withDescription("List the machines this HinaCode reaches."),
)

const stop = Command.make("stop", { thread: threadArgument }, (args) =>
  emit(
    withThread(args.thread, (client, thread) =>
      Effect.as(client.call("threads.interrupt", { threadId: thread.id }), succeed({ threadId: thread.id })),
    ),
  ),
).pipe(Command.withDescription("Interrupt a thread's turn."))

const open = Command.make("open", { thread: threadArgument }, (args) =>
  emit(
    withThread(args.thread, (client, thread) =>
      Effect.as(client.call("threads.reveal", { threadId: thread.id }), succeed({ threadId: thread.id })),
    ),
  ),
).pipe(Command.withDescription("Show a thread in the desktop window."))

const deliver = (client: Client, thread: Thread, text: string, queue: boolean) => {
  const threadId = thread.id
  if (queue) return Effect.as(client.call("threads.queue", { threadId, text }), "queue" as const)
  if (isThreadBusy(thread.status)) return Effect.as(client.call("threads.steer", { threadId, text }), "steer" as const)
  return Effect.as(client.call("threads.send", { threadId, prompt: text }), "send" as const)
}

const send = Command.make(
  "send",
  {
    thread: threadArgument,
    text: Argument.String("text").pipe(Argument.withDescription("The message.")),
    queue: Flag.Boolean("queue").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Queue the message for after the current turn."),
    ),
    wait: Flag.Boolean("wait").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Block until the turn ends or asks for something, then print the outcome, like run --wait."),
    ),
  },
  (args) =>
    emit(
      withThread(args.thread, (client, thread) =>
        Effect.gen(function* () {
          if (!args.wait) {
            const delivery = yield* deliver(client, thread, args.text, args.queue)
            return succeed({ threadId: thread.id, delivery })
          }
          const events = yield* client.subscribe
          yield* client.watch([thread.id])
          yield* deliver(client, thread, args.text, args.queue)
          return yield* awaitOutcome(events, thread)
        }),
      ),
    ),
).pipe(Command.withDescription("Steer a running thread, or start a turn on an idle one."))

const log = Command.make("log", { thread: threadArgument }, (args) =>
  emit(
    withThread(args.thread, (client, thread) =>
      Effect.gen(function* () {
        const transcript = yield* client.call("threads.transcript", { threadId: thread.id })
        return succeed(yield* encode(RpcMethods["threads.transcript"].response, transcript))
      }),
    ),
  ),
).pipe(Command.withDescription("Print a thread's transcript."))

export const threadCommands = [ls, send, stop, log, open, machines, rpc] as const
