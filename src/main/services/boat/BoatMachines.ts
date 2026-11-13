import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { PushEvent, RpcMethod } from "../../../shared/contract.ts"
import {
  type BoatMachineConnect,
  type BoatMachineCreate,
  type BoatMachineOptions,
  type BoatThreadMachine,
  type Environment,
  Project,
} from "../../../shared/domain.ts"
import { GitHubRepository } from "../../../shared/github.ts"
import { pairingUrl, parsePairingUrl } from "../../../shared/remote.ts"
import {
  type EnvironmentUnauthorized,
  type EnvironmentUnreachable,
  Environments,
  type InvalidPairingUrl,
} from "../Environments.ts"
import type { PersistenceError } from "../errors.ts"
import type { SandboxGoneError } from "../tinyVm/sbx.ts"
import {
  Boat,
  type BoatClient,
  type BoatError,
  type BoatNotConfiguredError,
  type BoatSnapshotExpiredError,
  isBoatReady,
} from "./Boat.ts"
import { DEV_PACKAGE_PATH, machineScript } from "./machineScript.ts"

export class BoatMachineError extends Schema.TaggedError<BoatMachineError>()("BoatMachineError", {
  message: Schema.String,
}) {}

const MACHINE_SCRIPT_TIMEOUT_SECONDS = 300
const OUTPUT_TAIL_CHARS = 600

const STOPPED_STATES = ["archived", "archiving", "stopped"]

export const THREAD_LABEL = "thread"

const text = new TextDecoder()

const ThreadEnd = Schema.Struct({
  status: Schema.String,
  settledAt: Schema.optional(Schema.NullOr(Schema.String)),
})
type ThreadEnd = typeof ThreadEnd.Type

const decodeThreadEnds = Schema.decodeUnknownOption(Schema.Array(ThreadEnd))
const decodeProject = Schema.decodeUnknownOption(Project)
const decodeRepository = Schema.decodeUnknownOption(GitHubRepository)

const createOptions = (create: BoatMachineCreate, kind: string) => ({
  type: create.type,
  labels: { hinacode: kind },
  ttlSeconds: create.autoStopHours === null ? null : create.autoStopHours * 3600,
  noEnv: create.noEnv,
  snapshots: create.snapshots,
  monitoring: create.monitoring,
  ...(create.name.trim() !== "" && { name: create.name.trim() }),
  ...(create.from.trim() !== "" && { from: create.from.trim() }),
  ...(create.environment !== "" && { environment: create.environment }),
  ...(create.setupScript.trim() !== "" && { setupScript: create.setupScript }),
})

const wake = (client: BoatClient, id: string) =>
  Effect.flatMap(client.getSandbox(id), (sandbox) => {
    if (isBoatReady(sandbox.state)) return Effect.succeed({ id })
    if (STOPPED_STATES.includes(sandbox.state)) return client.resume(id, {})
    return client.waitReady(id)
  })

const uploadDevPackage = (client: BoatClient, id: string, path: string) =>
  Effect.tryPromise({
    try: () => readFile(path),
    catch: () => new BoatMachineError({ message: `Could not read HINACODE_BOAT_PACKAGE at ${path}.` }),
  }).pipe(Effect.flatMap((bytes) => client.writeFileBytes(id, DEV_PACKAGE_PATH, bytes)))

const install = (client: BoatClient, id: string, devPackage: string | undefined) =>
  Effect.gen(function* () {
    if (devPackage !== undefined) yield* uploadDevPackage(client, id, devPackage)
    const result = yield* client.exec(id, {
      script: machineScript(devPackage !== undefined),
      timeoutSeconds: MACHINE_SCRIPT_TIMEOUT_SECONDS,
    })
    const pairing = parsePairingUrl(text.decode(result.stdout))
    if (result.exitCode === 0 && pairing !== null) return pairing
    const output = text.decode(result.stderr).trim().slice(-OUTPUT_TAIL_CHARS)
    return yield* new BoatMachineError({
      message: `HinaCode did not start on the boat sandbox (exit ${result.exitCode}).${output === "" ? "" : `\n${output}`}`,
    })
  })

const quietly =
  <E>(what: string) =>
  (effect: Effect.Effect<void, E>) =>
    effect.pipe(Effect.catchCause((cause) => Effect.logWarning(what, cause)))

export const everyThreadSettled = (threads: ReadonlyArray<ThreadEnd>) =>
  threads.every(
    (thread) => thread.status === "draft" || thread.status === "archived" || (thread.settledAt ?? null) !== null,
  )

const endsThread = (event: PushEvent) =>
  event.type === "thread.updated" && (event.thread.settledAt !== null || event.thread.status === "archived")

const ENDING_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>(["threads.settle", "threads.archive"])

type ConnectError =
  | BoatError
  | BoatNotConfiguredError
  | BoatSnapshotExpiredError
  | SandboxGoneError
  | BoatMachineError
  | InvalidPairingUrl
  | EnvironmentUnreachable
  | EnvironmentUnauthorized
  | PersistenceError

export class BoatMachines extends Context.Service<
  BoatMachines,
  {
    readonly options: Effect.Effect<
      BoatMachineOptions,
      BoatError | BoatNotConfiguredError | BoatSnapshotExpiredError | SandboxGoneError
    >
    readonly connect: (input: BoatMachineConnect) => Effect.Effect<Environment, ConnectError>
    readonly forThread: (input: BoatThreadMachine) => Effect.Effect<Project, ConnectError>
  }
>()("hinacode/BoatMachines") {}

const make = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const devPackage = env["HINACODE_BOAT_PACKAGE"] || undefined
    const boat = yield* Boat
    const configured = Effect.match(boat.client, { onFailure: () => false, onSuccess: () => true })
    const environments = yield* Environments
    const threadSandboxes = new Map<string, string>()
    const waking = new Set<string>()

    const options = Effect.gen(function* () {
      if (!(yield* configured)) return { configured: false } as const
      const client = yield* boat.client
      const [sandboxes, boatEnvironments, snapshots] = yield* Effect.all(
        [client.listAll(), client.environments(), client.savedSnapshots()],
        { concurrency: "unbounded" },
      )
      return {
        configured: true,
        sandboxes: sandboxes
          .filter((sandbox) => sandbox.state !== "cancelled")
          .map(({ id, name, state, type }) => ({ id, name, state, type })),
        environments: boatEnvironments.map(({ name, isDefault }) => ({ name, isDefault: isDefault ?? false })),
        snapshots: snapshots.filter((snapshot) => snapshot.status === "ready").map((snapshot) => snapshot.name),
      } as const
    })

    const pair = (client: BoatClient, id: string) =>
      Effect.gen(function* () {
        const { port, token } = yield* install(client, id, devPackage)
        const hosted = yield* client.hostPort(id, port, { public: true, localhost: true })
        const relay = URL.parse(hosted)?.hostname
        if (relay === undefined)
          return yield* new BoatMachineError({ message: "boat answered an unexpected public URL for the machine." })
        const sandbox = yield* client.getSandbox(id)
        return yield* environments.add({
          name: sandbox.name,
          pairingUrl: pairingUrl({ hosts: [relay], port: 443, token, relay }),
        })
      })

    const connect = (input: BoatMachineConnect) =>
      Effect.gen(function* () {
        const client = yield* boat.client
        const { id } =
          "create" in input.sandbox
            ? yield* client.createSandbox(createOptions(input.sandbox.create, "machine"))
            : yield* wake(client, input.sandbox.id)
        return yield* pair(client, id)
      })

    const forThread = (input: BoatThreadMachine) =>
      Effect.gen(function* () {
        const [owner = "", name = ""] = input.repository.split("/")
        const repository = Option.getOrUndefined(decodeRepository({ owner, name }))
        if (repository === undefined)
          return yield* new BoatMachineError({ message: "A boat sandbox needs a project with a GitHub repository." })
        const client = yield* boat.client
        const { id } = yield* client.createSandbox(createOptions(input.create, THREAD_LABEL))
        const environment = yield* pair(client, id)
        threadSandboxes.set(environment.id, id)
        const envelope = yield* environments.forward(environment.id, {
          method: "projects.clone",
          payload: {
            cloneId: randomUUID(),
            repository,
            rootPath: `~/${repository.name}`,
            name: input.projectName,
            setupScript: input.setupScript,
          },
        })
        if ("error" in envelope) return yield* new BoatMachineError({ message: envelope.error.message })
        const project = Option.getOrUndefined(decodeProject(envelope.result))
        if (project === undefined)
          return yield* new BoatMachineError({ message: "The boat machine answered an unexpected project." })
        return project
      })

    const threadSandbox = (client: BoatClient, environmentId: string) =>
      Effect.gen(function* () {
        const known = threadSandboxes.get(environmentId)
        if (known !== undefined) return known
        const { clouds } = yield* environments.list
        const host = clouds.find((cloud) => cloud.id === environmentId)?.host
        if (host === undefined) return undefined
        const sandboxes = yield* client.listAll()
        const found = sandboxes.find(
          (sandbox) =>
            sandbox.labels["hinacode"] === THREAD_LABEL &&
            sandbox.subdomain !== "" &&
            host.startsWith(`${sandbox.subdomain}-`),
        )
        if (found !== undefined) threadSandboxes.set(environmentId, found.id)
        return found?.id
      })

    const stopWhenSettled = (environmentId: string) =>
      Effect.gen(function* () {
        if (!(yield* configured)) return
        const client = yield* boat.client
        const id = yield* threadSandbox(client, environmentId)
        if (id === undefined) return
        const envelope = yield* environments.forward(environmentId, { method: "threads.list", payload: undefined })
        const threads = "error" in envelope ? undefined : Option.getOrUndefined(decodeThreadEnds(envelope.result))
        if (threads === undefined)
          return yield* Effect.logWarning("could not read the threads of a boat thread machine", environmentId)
        if (!everyThreadSettled(threads)) return
        yield* client.stop(id)
        yield* Effect.logInfo("stopped the boat sandbox of a settled thread", id)
      })

    const wakeThreadMachine = (environmentId: string) =>
      Effect.gen(function* () {
        if (waking.has(environmentId) || !(yield* configured)) return
        const client = yield* boat.client
        const id = yield* threadSandbox(client, environmentId)
        if (id === undefined) return
        waking.add(environmentId)
        yield* wake(client, id).pipe(
          Effect.andThen(environments.reconnect(environmentId)),
          Effect.ensuring(Effect.sync(() => waking.delete(environmentId))),
        )
      })

    const stopQuietly = (environmentId: string) =>
      stopWhenSettled(environmentId).pipe(quietly("could not stop a settled thread's boat sandbox"))

    yield* environments.hook({
      pushed: (environmentId, event) => (endsThread(event) ? stopQuietly(environmentId) : Effect.void),
      answered: (environmentId, method) => (ENDING_METHODS.has(method) ? stopQuietly(environmentId) : Effect.void),
      offlineMutation: (environmentId) =>
        wakeThreadMachine(environmentId).pipe(quietly("could not resume a thread's boat sandbox")),
    })

    return BoatMachines.of({ options, connect, forThread })
  })

export const layer = (env: Readonly<Record<string, string | undefined>>) => Layer.effect(BoatMachines, make(env))
