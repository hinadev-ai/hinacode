import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { Socket } from "node:net"
import { join } from "node:path"
import { Context, Deferred, Effect, Exit, Layer, Option, Schema, Semaphore, Stream } from "effect"
import type { PushEvent } from "../../../shared/contract.ts"
import {
  type BoatVmSize,
  defaultSettings,
  type ThreadVm,
  type VmControl,
  type VmHostStatus,
  type VmProfile,
  type VmProvider,
} from "../../../shared/domain.ts"
import { Boat, type BoatClient, BoatError, BoatSnapshotExpiredError } from "../boat/Boat.ts"
import { Events } from "../Events.ts"
import { Settings } from "../Settings.ts"
import { encodeAction, handshake, type VmAction, VmInputError, writeSteps } from "./rfb.ts"
import {
  type ExecInput,
  type ExecResult,
  type LoginSource,
  readLogin,
  SandboxGoneError,
  type SbxClient,
  SbxError,
  sbxClient,
} from "./sbx.ts"
import { decodeTar, encodeTar, readTree, type WrittenTree, writeTree } from "./tar.ts"
import { xdotoolScript } from "./xdotool.ts"

type SandboxClientError = SandboxGoneError | SbxError | BoatError | BoatSnapshotExpiredError

interface SandboxClient {
  readonly url: string
  readonly status: Effect.Effect<{ readonly sandboxes: number; readonly maxSandboxes: number }, SandboxClientError>
  readonly create: (
    template: string,
    env?: Readonly<Record<string, string>>,
  ) => Effect.Effect<{ readonly id: string }, SandboxClientError>
  readonly templates: Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly cpus: number; readonly memoryMiB: number }>,
    SandboxClientError
  >
  readonly get: (id: string) => Effect.Effect<{ readonly id: string }, SandboxClientError>
  readonly remove: (id: string) => Effect.Effect<void, SandboxClientError>
  readonly exec: (id: string, input: ExecInput) => Effect.Effect<ExecResult, SandboxClientError>
  readonly putFiles: (id: string, guestPath: string, tar: Uint8Array) => Effect.Effect<void, SandboxClientError>
  readonly getFiles: (id: string, guestPath: string, maxBytes?: number) => Effect.Effect<Uint8Array, SandboxClientError>
}

export class VmError extends Schema.TaggedError<VmError>()("VmError", { message: Schema.String }) {}

export interface ScreenOwner {
  readonly once: (event: "destroyed", listener: () => void) => unknown
}

export interface VmExec {
  readonly command: string
  readonly timeoutSeconds: number
  readonly background: boolean
}

export class TinyVm extends Context.Service<
  TinyVm,
  {
    readonly enabled: () => boolean
    readonly get: (threadId: string) => Effect.Effect<ThreadVm>
    readonly start: (threadId: string, template?: string) => Effect.Effect<ThreadVm>
    readonly stop: (threadId: string) => Effect.Effect<void>
    readonly setControl: (threadId: string, control: VmControl) => Effect.Effect<ThreadVm>
    readonly host: Effect.Effect<VmHostStatus>
    readonly desktopUrl: (threadId: string) => Effect.Effect<string, VmError>
    readonly screenshot: (threadId: string) => Effect.Effect<Uint8Array, VmError>
    readonly act: (threadId: string, actions: ReadonlyArray<VmAction>) => Effect.Effect<"done" | "handedBack", VmError>
    readonly exec: (threadId: string, input: VmExec) => Effect.Effect<ExecResult, VmError>
    readonly dropFiles: (
      threadId: string,
      hostPaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VmError>
    readonly takeDropped: (threadId: string) => Effect.Effect<ReadonlyArray<string>>
    readonly stageArchive: (threadId: string, guestPath: string, tar: Uint8Array) => Effect.Effect<void, VmError>
    readonly pullFiles: (threadId: string, guestPath: string) => Effect.Effect<WrittenTree, VmError>
    readonly openTunnel: (
      threadId: string,
      port: number,
    ) => Effect.Effect<{ readonly socket: Socket; readonly head: Uint8Array }, VmError>
    readonly saveProfile: (threadId: string) => Effect.Effect<void, VmError>
    readonly openScreen: (threadId: string, streamId: string, owner: ScreenOwner) => Effect.Effect<void, VmError>
    readonly sendScreen: (streamId: string, data: Uint8Array) => Effect.Effect<void>
    readonly closeScreen: (streamId: string) => Effect.Effect<void>
  }
>()("hinacode/TinyVm") {}

const VNC_PORT = 5900
const PROFILE_GUEST_ARCHIVE = "hinacode-chromium-profile.tgz"
const PROFILE_STORE = "chromium-profile.tgz"
const PROFILE_META = "chromium-profile.json"
const PROFILE_SCRIPT_TIMEOUT_SECONDS = 120
const SETUP_SCRIPT_TIMEOUT_SECONDS = 600
const SETUP_OUTPUT_TAIL = 2000
const PROFILE_EXCLUDES = [
  "chromium/*/Cache",
  "chromium/*/Code Cache",
  "chromium/*/GPUCache",
  "chromium/ShaderCache",
  "chromium/GrShaderCache",
  "chromium/component_crx_cache",
  "chromium/Singleton*",
  "chromium/Crash Reports",
  "chromium/BrowserMetrics*",
]
  .map((pattern) => `--exclude='${pattern}'`)
  .join(" ")

const PROFILE_ABSENT_EXIT = 42

const profileSaveScript = (quiesce: boolean) =>
  [
    `[ -d ~/.config/chromium ] || exit ${PROFILE_ABSENT_EXIT}`,
    ...(quiesce ? ["pkill -TERM chromium 2>/dev/null; sleep 1"] : []),
    "sync",
    `tar -czf /tmp/${PROFILE_GUEST_ARCHIVE} -C ~/.config ${PROFILE_EXCLUDES} chromium`,
  ].join("\n")

const PROFILE_RESTORE_SCRIPT = [
  "set -e",
  "was_cdp=0; curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1 && was_cdp=1",
  "pkill -TERM chromium 2>/dev/null || true",
  "for _ in $(seq 20); do pgrep chromium >/dev/null || break; sleep 0.25; done",
  "pkill -KILL chromium 2>/dev/null || true",
  "rm -rf ~/.config/chromium",
  "mkdir -p ~/.config",
  `tar -xzf /tmp/${PROFILE_GUEST_ARCHIVE} -C ~/.config`,
  `rm -f ~/.config/chromium/Singleton* /tmp/${PROFILE_GUEST_ARCHIVE}`,
  'if [ "$was_cdp" = 1 ] && command -v sbx-browser >/dev/null; then sbx-browser >/dev/null 2>&1 || true; fi',
].join("\n")

const DROP_DIR = "Downloads"
export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024
const PULLED_DIR = "pulled"
const SCREENSHOT_SCRIPT = "import -window root png:-"
const SCREENSHOT_TIMEOUT_SECONDS = 30
const BOAT_SANDBOXES_FILE = "boat-sandboxes.json"
const BOAT_PREPARE_SCRIPT = [
  "command -v xdotool >/dev/null && command -v import >/dev/null && exit 0",
  "sudo apt-get update -qq && sudo apt-get install -y -qq xdotool imagemagick wmctrl xclip",
].join("\n")
const BOAT_PREPARE_TIMEOUT_SECONDS = 600
const BoatSandboxMap = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
const BOAT_SIZES: ReadonlyArray<BoatVmSize> = ["small", "default", "large", "xlarge"]
const isBoatSize = (value: string | undefined): value is BoatVmSize => BOAT_SIZES.some((size) => size === value)
const FLUSH_INTERVAL_MS = 16
const FLUSH_SIZE = 256 * 1024
export const HAND_BACK_GRACE = "2 seconds"

const NONE: ThreadVm = { status: "none" }

interface Screen {
  readonly threadId: string
  readonly socket: Socket
  pending: Array<Uint8Array>
  pendingSize: number
  timer: ReturnType<typeof setTimeout> | undefined
}

const toVmError = (error: { readonly message: string }) => new VmError({ message: error.message })

const endGracefully = (socket: Socket) =>
  Effect.callback<void>((resume) => {
    socket.once("close", () => resume(Effect.void))
    socket.end()
  }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }))

const writeStoredProfile = (dataDir: string, bytes: Uint8Array, template: string): Effect.Effect<void, VmError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dataDir, { recursive: true })
      const temp = join(dataDir, `${PROFILE_STORE}.${process.pid}.tmp`)
      await writeFile(temp, bytes, { mode: 0o600 })
      await rename(temp, join(dataDir, PROFILE_STORE))
      await writeFile(join(dataDir, PROFILE_META), JSON.stringify({ savedAt: new Date().toISOString(), template }), {
        mode: 0o600,
      })
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new VmError({
          message: `Could not store the browser profile on this machine: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  )

const make = (source: LoginSource, dataDir: string, desktopRedirect = true) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const events = yield* Events
    const settings = yield* Settings
    const boatService = yield* Effect.serviceOption(Boat)

    const vms = new Map<string, ThreadVm>()
    const creations = new Map<string, Deferred.Deferred<ThreadVm>>()
    const waiting = new Map<string, number>()
    const dropped = new Map<string, Array<string>>()
    const handBacks = new Map<string, Deferred.Deferred<void>>()
    const screens = new Map<string, Screen>()
    const openingScreens = new Set<string>()
    const ownedScreens = new WeakMap<ScreenOwner, Set<string>>()
    const experimental = yield* settings.get.pipe(
      Effect.map((value) => value.experimental),
      Effect.orElseSucceed(() => defaultSettings.experimental),
    )
    let enabled = experimental.tinyVm
    let provider: VmProvider = experimental.tinyVmProvider
    let boatSize: BoatVmSize = experimental.tinyVmBoatSize
    let configuredTemplate = experimental.tinyVmTemplate.trim() || "default"
    let configuredEnv = experimental.tinyVmEnv
    let setupScript = experimental.tinyVmSetupScript
    let profileEnabled = experimental.tinyVmProfile
    let profileOwner: string | undefined
    const profileSaves = yield* Semaphore.make(1)
    const boatMapLock = yield* Semaphore.make(1)

    const current = (threadId: string) => vms.get(threadId) ?? NONE

    const runFork = Effect.runForkWith(yield* Effect.context<never>())
    const publishUnsafe = (event: PushEvent) => runFork(events.publish(event))

    const setVm = (threadId: string, vm: ThreadVm) =>
      Effect.suspend(() => {
        if (vm.status === "none") vms.delete(threadId)
        else vms.set(threadId, vm)
        if (!(vm.status === "running" && vm.control === "user")) {
          const handBack = handBacks.get(threadId)
          handBacks.delete(threadId)
          if (handBack) Deferred.doneUnsafe(handBack, Exit.void)
        }
        return events.publish({ type: "vm.updated", threadId, vm })
      })

    const sbxClientEffect = readLogin(source).pipe(Effect.map(sbxClient), Effect.mapError(toVmError))
    const boatClientEffect: Effect.Effect<BoatClient, VmError> = Option.match(boatService, {
      onNone: () => Effect.fail(new VmError({ message: "Boat is not available in this build." })),
      onSome: (boat) => boat.client.pipe(Effect.mapError(toVmError)),
    })
    const clientFor = (vmProvider: VmProvider): Effect.Effect<SandboxClient, VmError> =>
      vmProvider === "boat" ? boatClientEffect : sbxClientEffect

    const releaseProfileOwner = (threadId: string) => {
      if (profileOwner === threadId) profileOwner = undefined
    }

    const readStoredProfile: Effect.Effect<Uint8Array | undefined> = Effect.tryPromise({
      try: () => readFile(join(dataDir, PROFILE_STORE)),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((bytes) => bytes as Uint8Array),
      Effect.catch((cause) =>
        (cause as NodeJS.ErrnoException).code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.as(Effect.logWarning("tiny vm: cannot read the stored browser profile", String(cause)), undefined),
      ),
    )

    const restoreProfile = (sbx: SandboxClient, sandboxId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const stored = yield* readStoredProfile
        if (stored === undefined) return true
        const wrapped = encodeTar([
          {
            type: "file",
            path: PROFILE_GUEST_ARCHIVE,
            data: stored,
            mode: 0o600,
            mtime: Math.floor(Date.now() / 1000),
          },
        ])
        yield* sbx.putFiles(sandboxId, "/tmp", wrapped)
        const result = yield* sbx.exec(sandboxId, {
          script: PROFILE_RESTORE_SCRIPT,
          timeoutSeconds: PROFILE_SCRIPT_TIMEOUT_SECONDS,
        })
        if (result.exitCode !== 0)
          return yield* new VmError({
            message: `restoring the browser profile failed: ${Buffer.from(result.stderr).toString().trim()}`,
          })
        return true
      }).pipe(
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning("tiny vm: browser profile restore failed, starting with a fresh profile", error.message),
            false,
          ),
        ),
      )

    const prepareProfile = (threadId: string, sbx: SandboxClient, sandboxId: string): Effect.Effect<VmProfile> =>
      Effect.suspend(() => {
        if (!profileEnabled) return Effect.succeed<VmProfile>("off")
        const role: VmProfile =
          profileOwner === undefined
            ? ((profileOwner = threadId), "owner")
            : profileOwner === threadId
              ? "owner"
              : "copy"
        return Effect.map(restoreProfile(sbx, sandboxId), (restored) => {
          if (restored) return role
          if (role === "owner") releaseProfileOwner(threadId)
          return "off" as VmProfile
        })
      })

    const saveFromSandbox = (sbx: SandboxClient, sandboxId: string, template: string, quiesce: boolean) =>
      profileSaves.withPermit(
        Effect.gen(function* () {
          const built = yield* sbx
            .exec(sandboxId, { script: profileSaveScript(quiesce), timeoutSeconds: PROFILE_SCRIPT_TIMEOUT_SECONDS })
            .pipe(Effect.mapError(toVmError))
          if (built.exitCode === PROFILE_ABSENT_EXIT) return
          if (built.exitCode !== 0)
            return yield* new VmError({
              message: `Saving the browser profile failed in the VM: ${Buffer.from(built.stderr).toString().trim()}`,
            })
          const wrapped = yield* sbx
            .getFiles(sandboxId, `/tmp/${PROFILE_GUEST_ARCHIVE}`)
            .pipe(Effect.mapError(toVmError))
          const entries = yield* Effect.try({
            try: () => decodeTar(wrapped),
            catch: (cause) => new VmError({ message: cause instanceof Error ? cause.message : String(cause) }),
          })
          const entry = entries.find((candidate) => candidate.type === "file")
          if (entry === undefined || entry.type !== "file")
            return yield* new VmError({ message: "The VM did not return a browser profile archive" })
          yield* writeStoredProfile(dataDir, entry.data, template)
        }),
      )

    const saveProfile = (threadId: string) =>
      Effect.gen(function* () {
        const vm = current(threadId)
        if (vm.status !== "running") return yield* new VmError({ message: "The VM is not running" })
        if (vm.profile === "copy")
          return yield* new VmError({ message: "Another thread's VM saves the browser profile. This VM holds a copy." })
        if (vm.profile === "off")
          return yield* new VmError({ message: "The persistent browser profile is off for this VM" })
        const sbx = yield* sbxClientEffect
        yield* saveFromSandbox(sbx, vm.sandboxId, vm.template, false)
      })

    const closeScreensOf = (threadId: string) =>
      screens.forEach((screen) => screen.threadId === threadId && screen.socket.destroy())

    const forget = (threadId: string, sandboxId: string) =>
      Effect.suspend(() => {
        const vm = current(threadId)
        if (vm.status !== "running" || vm.sandboxId !== sandboxId) return Effect.void
        closeScreensOf(threadId)
        dropped.delete(threadId)
        releaseProfileOwner(threadId)
        return setVm(threadId, NONE)
      })

    const settle = (threadId: string, done: Deferred.Deferred<ThreadVm>, vm: ThreadVm) =>
      Effect.gen(function* () {
        const live = creations.get(threadId) === done
        if (live) {
          creations.delete(threadId)
          yield* setVm(threadId, vm)
        }
        yield* Deferred.succeed(done, live ? vm : NONE)
        return live
      })

    const runSetupScript = (sbx: SandboxClient, sandboxId: string) =>
      Effect.gen(function* () {
        if (setupScript.trim() === "") return
        const result = yield* sbx
          .exec(sandboxId, { script: setupScript, timeoutSeconds: SETUP_SCRIPT_TIMEOUT_SECONDS })
          .pipe(Effect.mapError(toVmError))
        if (result.exitCode === 0) return
        const output = Buffer.concat([result.stdout, result.stderr]).toString().trim().slice(-SETUP_OUTPUT_TAIL)
        return yield* new VmError({
          message: `The setup script exited with code ${result.exitCode}.${output ? `\n${output}` : ""}`,
        })
      })

    const readBoatMap: Effect.Effect<Record<string, string>> = Effect.tryPromise({
      try: () => readFile(join(dataDir, BOAT_SANDBOXES_FILE), "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((contents) => Schema.decodeUnknownEffect(BoatSandboxMap)(contents)),
      Effect.map((map) => ({ ...map })),
      Effect.catch(() => Effect.succeed<Record<string, string>>({})),
    )

    const writeBoatMap = (map: Record<string, string>) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dataDir, { recursive: true })
          const target = join(dataDir, BOAT_SANDBOXES_FILE)
          const temporary = `${target}.${randomUUID()}.tmp`
          await writeFile(temporary, JSON.stringify(map), { mode: 0o600 })
          await rename(temporary, target)
        },
        catch: (cause) => cause,
      }).pipe(Effect.catch((cause) => Effect.logWarning("tiny vm: cannot store the boat sandbox map", String(cause))))

    const updateBoatMap = (threadId: string, sandboxId: string | undefined) =>
      boatMapLock.withPermits(1)(
        Effect.flatMap(readBoatMap, (map) => {
          if (sandboxId === undefined) delete map[threadId]
          else map[threadId] = sandboxId
          return writeBoatMap(map)
        }),
      )

    const runBoatPrepare = (boat: BoatClient, sandboxId: string) =>
      Effect.gen(function* () {
        const result = yield* boat
          .exec(sandboxId, { script: BOAT_PREPARE_SCRIPT, timeoutSeconds: BOAT_PREPARE_TIMEOUT_SECONDS })
          .pipe(Effect.mapError(toVmError))
        if (result.exitCode === 0) return
        const output = Buffer.concat([result.stdout, result.stderr]).toString().trim().slice(-SETUP_OUTPUT_TAIL)
        return yield* new VmError({
          message: `Preparing the boat VM failed with exit code ${result.exitCode}.${output ? `\n${output}` : ""}`,
        })
      })

    const boatStart = (boat: BoatClient, threadId: string, size: string) =>
      Effect.gen(function* () {
        const map = yield* readBoatMap
        const existing = map[threadId]
        if (existing !== undefined) {
          const adopted = yield* boat.getSandbox(existing).pipe(
            Effect.flatMap((sandbox) => {
              if (sandbox.state === "ready" || sandbox.state === "idle" || sandbox.state === "running")
                return Effect.succeed({ id: existing, fresh: false })
              if (sandbox.state === "archived" || sandbox.state === "archiving")
                return Effect.as(boat.resume(existing), { id: existing, fresh: false })
              if (sandbox.state === "error" || sandbox.state === "cancelled") return Effect.succeed(undefined)
              return Effect.as(boat.waitReady(existing), { id: existing, fresh: false })
            }),
            Effect.catchTag("SandboxGoneError", () => Effect.succeed(undefined)),
            Effect.catchTag("BoatSnapshotExpiredError", () => Effect.succeed(undefined)),
            Effect.mapError(toVmError),
          )
          if (adopted !== undefined) return adopted
        }
        const created = yield* boat
          .createSandbox({
            type: size,
            env: configuredEnv,
            name: `hinacode-vm-${threadId}`.slice(0, 120),
            labels: { "hinacode-kind": "tiny-vm" },
          })
          .pipe(Effect.mapError(toVmError))
        yield* updateBoatMap(threadId, created.id)
        return { id: created.id, fresh: true }
      })

    const prepareBoatSandbox = (threadId: string, size: string) =>
      Effect.gen(function* () {
        const boat = yield* boatClientEffect
        const started = yield* boatStart(boat, threadId, size)
        if (started.fresh) {
          yield* runBoatPrepare(boat, started.id).pipe(
            Effect.andThen(runSetupScript(boat, started.id)),
            Effect.tapError(() =>
              Effect.andThen(Effect.ignore(boat.remove(started.id)), updateBoatMap(threadId, undefined)),
            ),
          )
        }
        return {
          sandboxId: started.id,
          profile: "off" as VmProfile,
          dispose: Effect.ignore(boat.stop(started.id)),
        }
      })

    const prepareSbxSandbox = (threadId: string, template: string) =>
      Effect.gen(function* () {
        const sbx = yield* sbxClientEffect
        const sandbox = yield* sbx.create(template, configuredEnv).pipe(Effect.mapError(toVmError))
        yield* runSetupScript(sbx, sandbox.id).pipe(Effect.tapError(() => Effect.ignore(sbx.remove(sandbox.id))))
        const profile = yield* prepareProfile(threadId, sbx, sandbox.id)
        return { sandboxId: sandbox.id, profile, dispose: Effect.ignore(sbx.remove(sandbox.id)) }
      })

    const create = (threadId: string, done: Deferred.Deferred<ThreadVm>, template: string) =>
      Effect.suspend(() => {
        if (!enabled)
          return settle(threadId, done, {
            status: "failed",
            message: "Tiny VM is off. Turn it on in Settings > Experimental.",
          })
        const startingProvider = provider
        const prepared =
          startingProvider === "boat" ? prepareBoatSandbox(threadId, template) : prepareSbxSandbox(threadId, template)
        return prepared.pipe(
          Effect.matchEffect({
            onFailure: (error) => settle(threadId, done, { status: "failed", message: error.message }),
            onSuccess: ({ sandboxId, profile, dispose }) =>
              Effect.gen(function* () {
                const live = yield* settle(threadId, done, {
                  status: "running",
                  provider: startingProvider,
                  sandboxId,
                  template,
                  profile,
                  control: "agent",
                })
                if (!live) {
                  releaseProfileOwner(threadId)
                  yield* dispose
                }
              }),
          }),
        )
      })

    const start = (threadId: string, templateOverride?: string) =>
      Effect.suspend((): Effect.Effect<ThreadVm> => {
        const vm = current(threadId)
        if (vm.status === "running") return Effect.succeed(vm)
        const pending = creations.get(threadId)
        if (pending) return Deferred.await(pending)
        const picked = templateOverride?.trim()
        const template = provider === "boat" ? (isBoatSize(picked) ? picked : boatSize) : picked || configuredTemplate
        const done = Deferred.makeUnsafe<ThreadVm>()
        creations.set(threadId, done)
        return setVm(threadId, { status: "starting" }).pipe(
          Effect.andThen(Effect.forkIn(create(threadId, done, template), scope)),
          Effect.andThen(Deferred.await(done)),
        )
      })

    const ensureRunning = (threadId: string) =>
      Effect.flatMap(start(threadId), (vm): Effect.Effect<Extract<ThreadVm, { status: "running" }>, VmError> => {
        if (vm.status === "running") return Effect.succeed(vm)
        if (vm.status === "failed") return Effect.fail(new VmError({ message: vm.message }))
        return Effect.fail(new VmError({ message: "The VM was stopped before it started." }))
      })

    const withSandbox = <A, E extends { readonly _tag: string; readonly message: string }>(
      threadId: string,
      use: (sbx: SandboxClient, sandboxId: string) => Effect.Effect<A, E>,
    ): Effect.Effect<A, VmError> =>
      Effect.gen(function* () {
        const { sandboxId, provider: vmProvider } = yield* ensureRunning(threadId)
        const sbx = yield* clientFor(vmProvider)
        return yield* use(sbx, sandboxId).pipe(
          Effect.catchIf(
            (error) => error._tag === "SandboxGoneError",
            (error) => Effect.andThen(forget(threadId, sandboxId), Effect.fail(error)),
          ),
          Effect.mapError(toVmError),
        )
      })

    const stop = (threadId: string) =>
      Effect.gen(function* () {
        const vm = current(threadId)
        creations.delete(threadId)
        dropped.delete(threadId)
        closeScreensOf(threadId)
        if (vm.status === "none") return
        if (vm.status === "running" && vm.provider === "sbx" && vm.profile === "owner" && profileEnabled) {
          yield* sbxClientEffect.pipe(
            Effect.flatMap((sbx) => saveFromSandbox(sbx, vm.sandboxId, vm.template, true)),
            Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.void }),
            Effect.catch((error) => Effect.logWarning("tiny vm: profile save on stop failed", error.message)),
          )
        }
        if (vm.status === "running" && vm.provider === "boat") {
          const stopped = yield* boatClientEffect.pipe(
            Effect.flatMap((boat) => boat.stop(vm.sandboxId)),
            Effect.as(true),
            Effect.catchTag("SandboxGoneError", () => Effect.succeed(true)),
            Effect.catch((error) =>
              Effect.andThen(Effect.logWarning("tiny vm: boat stop failed", error.message), Effect.succeed(false)),
            ),
          )
          if (!stopped) return
        }
        releaseProfileOwner(threadId)
        yield* setVm(threadId, NONE)
        if (vm.status !== "running") return
        if (vm.provider === "boat") return
        yield* sbxClientEffect.pipe(
          Effect.flatMap((sbx) => sbx.remove(vm.sandboxId)),
          Effect.catch((error) =>
            error._tag === "SandboxGoneError"
              ? Effect.void
              : Effect.logWarning("tiny vm: delete failed", error.message),
          ),
        )
      })

    const stopAll = Effect.suspend(() =>
      Effect.forEach(new Set([...vms.keys(), ...creations.keys()]), stop, { concurrency: "unbounded", discard: true }),
    )

    const refreshWaiting = (threadId: string) =>
      Effect.suspend(() => {
        const vm = current(threadId)
        const agentWaiting = (waiting.get(threadId) ?? 0) > 0
        if (vm.status !== "running" || vm.control !== "user" || vm.agentWaiting === agentWaiting) return Effect.void
        return setVm(threadId, { ...vm, agentWaiting })
      })

    const waitForHandBack = (threadId: string) =>
      Effect.suspend(() => {
        let handBack = handBacks.get(threadId)
        if (handBack === undefined) handBacks.set(threadId, (handBack = Deferred.makeUnsafe<void>()))
        waiting.set(threadId, (waiting.get(threadId) ?? 0) + 1)
        return refreshWaiting(threadId).pipe(
          Effect.andThen(Deferred.await(handBack)),
          Effect.ensuring(
            Effect.suspend(() => {
              const count = (waiting.get(threadId) ?? 1) - 1
              if (count === 0) waiting.delete(threadId)
              else waiting.set(threadId, count)
              return refreshWaiting(threadId)
            }),
          ),
        )
      })

    const setControl = (threadId: string, control: VmControl) =>
      Effect.suspend((): Effect.Effect<ThreadVm> => {
        const vm = current(threadId)
        if (vm.status !== "running") return Effect.succeed(vm)
        const next: ThreadVm =
          control === "user"
            ? {
                status: "running",
                provider: vm.provider,
                sandboxId: vm.sandboxId,
                template: vm.template,
                profile: vm.profile,
                control: "user",
                agentWaiting: (waiting.get(threadId) ?? 0) > 0,
              }
            : {
                status: "running",
                provider: vm.provider,
                sandboxId: vm.sandboxId,
                template: vm.template,
                profile: vm.profile,
                control: "agent",
              }
        return Effect.as(setVm(threadId, next), next)
      })

    const guardGone = <A, E extends { readonly _tag: string; readonly message: string }>(
      threadId: string,
      sandboxId: string,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, VmError> =>
      effect.pipe(
        Effect.catchIf(
          (error) => error._tag === "SandboxGoneError",
          (error) => Effect.andThen(forget(threadId, sandboxId), Effect.fail(error)),
        ),
        Effect.mapError(toVmError),
      )

    const performSbx = (sbx: SbxClient, sandboxId: string, actions: ReadonlyArray<VmAction>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { socket, head } = yield* Effect.acquireRelease(sbx.tunnel(sandboxId, VNC_PORT), (tunnel) =>
            Effect.sync(() => tunnel.socket.destroy()),
          )
          const screen = yield* handshake(socket, head)
          const steps = yield* Effect.try({
            try: () => actions.flatMap((action) => encodeAction(action, screen)),
            catch: (cause) => (cause instanceof VmInputError ? cause : new VmError({ message: String(cause) })),
          })
          yield* writeSteps(socket, steps)
          yield* endGracefully(socket)
        }),
      )

    const performBoat = (boat: BoatClient, sandboxId: string, actions: ReadonlyArray<VmAction>) =>
      Effect.gen(function* () {
        const script = yield* Effect.try({
          try: () => xdotoolScript(actions),
          catch: (cause) => (cause instanceof VmInputError ? cause : new VmError({ message: String(cause) })),
        })
        if (script === "") return
        const result = yield* boat.exec(sandboxId, { script, timeoutSeconds: 120 })
        if (result.exitCode !== 0)
          return yield* new VmError({
            message: `Driving the boat desktop failed with exit code ${result.exitCode}: ${Buffer.from(result.stderr).toString().trim()}`,
          })
      })

    const perform = (threadId: string, actions: ReadonlyArray<VmAction>) =>
      Effect.gen(function* () {
        const vm = yield* ensureRunning(threadId)
        if (vm.provider === "boat") {
          const boat = yield* boatClientEffect
          return yield* guardGone(threadId, vm.sandboxId, performBoat(boat, vm.sandboxId, actions))
        }
        const sbx = yield* sbxClientEffect
        return yield* guardGone(threadId, vm.sandboxId, performSbx(sbx, vm.sandboxId, actions))
      })

    const act = (threadId: string, actions: ReadonlyArray<VmAction>) =>
      Effect.gen(function* () {
        const vm = yield* ensureRunning(threadId)
        if (vm.control === "agent") {
          yield* perform(threadId, actions)
          return "done" as const
        }
        yield* waitForHandBack(threadId)
        if (current(threadId).status !== "running") {
          return yield* new VmError({ message: "The user stopped the VM. Call the tool again to start a fresh one." })
        }
        return "handedBack" as const
      })

    const screenshot = (threadId: string) =>
      withSandbox(threadId, (sbx, sandboxId) =>
        sbx.exec(sandboxId, { script: SCREENSHOT_SCRIPT, timeoutSeconds: SCREENSHOT_TIMEOUT_SECONDS }),
      ).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0 && result.stdout.length > 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new VmError({
                  message: `The screenshot failed with exit code ${result.exitCode}: ${Buffer.from(result.stderr).toString().trim()}`,
                }),
              ),
        ),
      )

    const exec = (threadId: string, input: VmExec) =>
      withSandbox(threadId, (sbx, sandboxId) =>
        sbx.exec(sandboxId, { script: input.command, timeoutSeconds: input.timeoutSeconds, detach: input.background }),
      )

    const dropFiles = (threadId: string, hostPaths: ReadonlyArray<string>) =>
      withSandbox(threadId, (sbx, sandboxId) =>
        Effect.gen(function* () {
          if (hostPaths.length === 0) return [] as ReadonlyArray<string>
          const archives: Array<{ readonly base: string; readonly tar: Uint8Array }> = []
          let remaining = MAX_TRANSFER_BYTES
          for (const hostPath of hostPaths) {
            const entries = yield* readTree(hostPath, remaining).pipe(Effect.mapError(toVmError))
            remaining -= entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.data.length : 0), 0)
            const tar = yield* Effect.try({
              try: () => encodeTar(entries),
              catch: (cause) => new VmError({ message: cause instanceof Error ? cause.message : String(cause) }),
            })
            archives.push({ base: entries[0]?.path ?? hostPath, tar })
          }
          const made = yield* sbx.exec(sandboxId, { script: `mkdir -p ~/${DROP_DIR}`, timeoutSeconds: 30 })
          if (made.exitCode !== 0)
            return yield* new VmError({
              message: `Could not create ~/${DROP_DIR} in the VM: ${Buffer.from(made.stderr).toString().trim()}`,
            })
          const guestPaths: Array<string> = []
          for (const archive of archives) {
            yield* sbx.putFiles(sandboxId, DROP_DIR, archive.tar)
            guestPaths.push(`~/${DROP_DIR}/${archive.base}`)
          }
          dropped.set(threadId, [...(dropped.get(threadId) ?? []), ...guestPaths])
          return guestPaths as ReadonlyArray<string>
        }),
      )

    const takeDropped = (threadId: string) =>
      Effect.sync(() => {
        const paths = dropped.get(threadId) ?? []
        dropped.delete(threadId)
        return paths as ReadonlyArray<string>
      })

    const stageArchive = (threadId: string, guestPath: string, tar: Uint8Array) =>
      withSandbox(threadId, (sbx, sandboxId) => sbx.putFiles(sandboxId, guestPath, tar))

    const pullFiles = (threadId: string, guestPath: string) =>
      withSandbox(threadId, (sbx, sandboxId) =>
        Effect.gen(function* () {
          const tar = yield* sbx.getFiles(sandboxId, guestPath.replace(/^~(\/|$)/, ""), MAX_TRANSFER_BYTES).pipe(
            // FIXME: sbxd answers 404 for both a missing path and a destroyed sandbox
            Effect.catchTag("SandboxGoneError", () =>
              Effect.andThen(sbx.get(sandboxId), new VmError({ message: `Nothing exists at ${guestPath} in the VM.` })),
            ),
            Effect.mapError((error) =>
              error._tag === "SbxError" || error._tag === "BoatError"
                ? new VmError({ message: `Cannot copy ${guestPath}: ${error.message}` })
                : error,
            ),
          )
          const entries = yield* Effect.try({
            try: () => decodeTar(tar),
            catch: (cause) => new VmError({ message: cause instanceof Error ? cause.message : String(cause) }),
          })
          return yield* writeTree(join(dataDir, PULLED_DIR, threadId, randomUUID()), entries)
        }),
      )

    const openTunnel = (threadId: string, port: number) =>
      Effect.gen(function* () {
        const vm = yield* ensureRunning(threadId)
        if (vm.provider === "boat")
          return yield* new VmError({
            message: "Port tunnels are not available on a boat VM, so passkeys and guest CDP stay off.",
          })
        const sbx = yield* sbxClientEffect
        return yield* guardGone(threadId, vm.sandboxId, sbx.tunnel(vm.sandboxId, port))
      })

    const fetchDesktopUrl = (threadId: string) =>
      Effect.gen(function* () {
        const vm = yield* ensureRunning(threadId)
        if (vm.provider !== "boat") return yield* new VmError({ message: "Only a boat VM has a desktop stream url." })
        const boat = yield* boatClientEffect
        return yield* guardGone(threadId, vm.sandboxId, boat.desktopUrl(vm.sandboxId))
      })

    const desktopNonces = new Map<string, { readonly threadId: string; readonly expiresAt: number }>()
    let desktopServer: Server | undefined
    let desktopStarting: Promise<number> | undefined

    const startDesktopServer = (): Promise<number> => {
      desktopStarting ??= new Promise<number>((resolve, reject) => {
        const server = createServer((request, response) => {
          const nonce = /^\/desktop\/([0-9a-f-]{36})$/.exec(request.url ?? "")?.[1]
          const entry = nonce === undefined ? undefined : desktopNonces.get(nonce)
          if (nonce !== undefined) desktopNonces.delete(nonce)
          if (entry === undefined || entry.expiresAt < Date.now()) {
            response.writeHead(404)
            response.end()
            return
          }
          Effect.runPromise(fetchDesktopUrl(entry.threadId)).then(
            (url) => {
              response.writeHead(302, { location: url })
              response.end()
            },
            () => {
              response.writeHead(502)
              response.end()
            },
          )
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          if (address === null || typeof address === "string") {
            reject(new Error("desktop redirect server has no port"))
            return
          }
          desktopServer = server
          resolve(address.port)
        })
      })
      return desktopStarting
    }

    const desktopUrl = (threadId: string) =>
      Effect.gen(function* () {
        const vm = yield* ensureRunning(threadId)
        if (vm.provider !== "boat") return yield* new VmError({ message: "Only a boat VM has a desktop stream url." })
        if (!desktopRedirect) return yield* fetchDesktopUrl(threadId)
        const port = yield* Effect.tryPromise({
          try: () => startDesktopServer(),
          catch: (cause) => new VmError({ message: `Cannot open the desktop stream: ${String(cause)}` }),
        })
        const now = Date.now()
        for (const [nonce, entry] of desktopNonces) if (entry.expiresAt < now) desktopNonces.delete(nonce)
        const nonce = randomUUID()
        desktopNonces.set(nonce, { threadId, expiresAt: now + 60_000 })
        return `http://127.0.0.1:${port}/desktop/${nonce}`
      })

    const sbxHost: Effect.Effect<VmHostStatus> = readLogin(source).pipe(
      Effect.map(sbxClient),
      Effect.flatMap((sbx) =>
        sbx.status.pipe(
          Effect.flatMap((status) =>
            sbx.templates.pipe(
              Effect.orElseSucceed(() => []),
              Effect.map((templates): VmHostStatus => ({
                status: "connected",
                provider: "sbx",
                url: sbx.url,
                ...status,
                templates,
              })),
            ),
          ),
          Effect.catch((error) =>
            Effect.succeed<VmHostStatus>({
              status: "unreachable",
              provider: "sbx",
              url: sbx.url,
              message: error.message,
            }),
          ),
        ),
      ),
      Effect.catchTags({
        SbxNotConfiguredError: () => Effect.succeed<VmHostStatus>({ status: "notConfigured", provider: "sbx" }),
        SbxError: (error) =>
          Effect.succeed<VmHostStatus>({
            status: "unreachable",
            provider: "sbx",
            url: source.configPath,
            message: error.message,
          }),
      }),
    )

    const boatHost: Effect.Effect<VmHostStatus> = Option.match(boatService, {
      onNone: () => Effect.succeed<VmHostStatus>({ status: "notConfigured", provider: "boat" }),
      onSome: (boat) =>
        boat.client.pipe(
          Effect.flatMap((client) =>
            client.status.pipe(
              Effect.flatMap((status) =>
                client.templates.pipe(
                  Effect.orElseSucceed(() => []),
                  Effect.map((templates): VmHostStatus => ({
                    status: "connected",
                    provider: "boat",
                    url: client.url,
                    ...status,
                    templates,
                  })),
                ),
              ),
              Effect.catch((error) =>
                Effect.succeed<VmHostStatus>({
                  status: "unreachable",
                  provider: "boat",
                  url: client.url,
                  message: error.message,
                }),
              ),
            ),
          ),
          Effect.catchTag("BoatNotConfiguredError", () =>
            Effect.succeed<VmHostStatus>({ status: "notConfigured", provider: "boat" }),
          ),
          Effect.catch((error) =>
            Effect.succeed<VmHostStatus>({
              status: "unreachable",
              provider: "boat",
              url: "boat.dev",
              message: error.message,
            }),
          ),
        ),
    })

    const host: Effect.Effect<VmHostStatus> = Effect.suspend(() => (provider === "boat" ? boatHost : sbxHost))

    const flush = (streamId: string, screen: Screen) => {
      clearTimeout(screen.timer)
      screen.timer = undefined
      if (screen.pendingSize === 0) return
      const data = Buffer.concat(screen.pending)
      screen.pending = []
      screen.pendingSize = 0
      publishUnsafe({ type: "vm.screen.data", streamId, data })
    }

    const buffer = (streamId: string, screen: Screen, data: Uint8Array) => {
      if (data.length === 0) return
      screen.pending.push(data)
      screen.pendingSize += data.length
      if (screen.pendingSize >= FLUSH_SIZE) flush(streamId, screen)
      else screen.timer ??= setTimeout(() => flush(streamId, screen), FLUSH_INTERVAL_MS)
    }

    const unwatchedByUser = (threadId: string) => {
      const vm = current(threadId)
      const watched = [...screens.values()].some((other) => other.threadId === threadId)
      return !watched && vm.status === "running" && vm.control === "user"
    }

    const screenClosed = (streamId: string, screen: Screen, owner: ScreenOwner) => {
      flush(streamId, screen)
      screens.delete(streamId)
      ownedScreens.get(owner)?.delete(streamId)
      publishUnsafe({ type: "vm.screen.closed", streamId })
      if (!unwatchedByUser(screen.threadId)) return
      runFork(
        Effect.sleep(HAND_BACK_GRACE).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              unwatchedByUser(screen.threadId) ? setControl(screen.threadId, "agent") : Effect.void,
            ),
          ),
        ),
      )
    }

    const own = (owner: ScreenOwner, streamId: string) => {
      let owned = ownedScreens.get(owner)
      if (owned === undefined) {
        const streams = new Set<string>()
        ownedScreens.set(owner, (owned = streams))
        owner.once("destroyed", () => streams.forEach((id) => screens.get(id)?.socket.destroy()))
      }
      owned.add(streamId)
    }

    const openScreen = (threadId: string, streamId: string, owner: ScreenOwner) =>
      Effect.gen(function* () {
        if (screens.has(streamId) || openingScreens.has(streamId)) {
          return yield* new VmError({ message: `Screen stream ${streamId} is already open.` })
        }
        const vm = current(threadId)
        if (vm.status !== "running") return yield* new VmError({ message: "The VM is not running." })
        if (vm.provider === "boat")
          return yield* new VmError({ message: "A boat VM shows its desktop stream instead of VNC." })
        openingScreens.add(streamId)
        const sbx = yield* sbxClientEffect
        const { socket, head } = yield* sbx.tunnel(vm.sandboxId, VNC_PORT, { passive: true }).pipe(
          Effect.catchTag("SandboxGoneError", (error) =>
            Effect.andThen(forget(threadId, vm.sandboxId), Effect.fail(error)),
          ),
          Effect.mapError(toVmError),
        )
        const screen: Screen = { threadId, socket, pending: [], pendingSize: 0, timer: undefined }
        screens.set(streamId, screen)
        own(owner, streamId)
        buffer(streamId, screen, head)
        socket.on("data", (data: Buffer) => buffer(streamId, screen, data))
        socket.on("error", () => {})
        socket.once("close", () => screenClosed(streamId, screen, owner))
      }).pipe(Effect.ensuring(Effect.sync(() => openingScreens.delete(streamId))))

    const sendScreen = (streamId: string, data: Uint8Array) =>
      Effect.sync(() => {
        const socket = screens.get(streamId)?.socket
        if (socket?.writable) socket.write(data)
      })

    const closeScreen = (streamId: string) => Effect.sync(() => screens.get(streamId)?.socket.destroy())

    yield* (yield* settings.changes).pipe(
      Stream.runForEach((value) =>
        Effect.suspend(() => {
          const was = enabled
          const wasProvider = provider
          enabled = value.experimental.tinyVm
          provider = value.experimental.tinyVmProvider
          boatSize = value.experimental.tinyVmBoatSize
          configuredTemplate = value.experimental.tinyVmTemplate.trim() || "default"
          configuredEnv = value.experimental.tinyVmEnv
          setupScript = value.experimental.tinyVmSetupScript
          profileEnabled = value.experimental.tinyVmProfile
          return (was && !enabled) || wasProvider !== provider ? stopAll : Effect.void
        }),
      ),
      Effect.forkIn(scope),
    )

    // FIXME: sbx's idle timeout can destroy a VM without asking
    yield* Effect.forever(
      Effect.sleep("10 minutes").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (profileOwner === undefined || !profileEnabled) return Effect.void
            const vm = current(profileOwner)
            if (vm.status !== "running" || vm.profile !== "owner") return Effect.void
            return sbxClientEffect.pipe(
              Effect.flatMap((sbx) => saveFromSandbox(sbx, vm.sandboxId, vm.template, false)),
              Effect.catch((error) => Effect.logWarning("tiny vm: profile autosave failed", error.message)),
            )
          }),
        ),
      ),
    ).pipe(Effect.forkIn(scope))

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        screens.forEach((screen) => screen.socket.destroy())
        desktopServer?.close()
        yield* stopAll
      }).pipe(Effect.ignore, Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.void })),
    )

    return TinyVm.of({
      enabled: () => enabled,
      get: (threadId) => Effect.sync(() => current(threadId)),
      start,
      stop,
      setControl,
      host,
      desktopUrl,
      screenshot,
      act,
      exec,
      dropFiles,
      takeDropped,
      stageArchive,
      pullFiles,
      openTunnel,
      saveProfile,
      openScreen,
      sendScreen,
      closeScreen,
    })
  })

export const layer = (source: LoginSource, dataDir: string, options?: { readonly desktopRedirect?: boolean }) =>
  Layer.effect(TinyVm, make(source, dataDir, options?.desktopRedirect ?? true))
