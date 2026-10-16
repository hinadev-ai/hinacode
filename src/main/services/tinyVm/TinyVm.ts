import type { Socket } from "node:net"
import { Context, Deferred, Effect, Exit, Layer, Schema, Stream } from "effect"
import type { PushEvent } from "../../../shared/contract.ts"
import type { ThreadVm, VmControl, VmHostStatus } from "../../../shared/domain.ts"
import { Events } from "../Events.ts"
import { Settings } from "../Settings.ts"
import { encodeAction, handshake, type VmAction, VmInputError, writeSteps } from "./rfb.ts"
import { type ExecResult, type LoginSource, readLogin, type SbxClient, sbxClient } from "./sbx.ts"

export class VmError extends Schema.TaggedError<VmError>()("VmError", { message: Schema.String }) {}

/** Whoever opened a screen stream, usually a window's WebContents. Its streams close when it is destroyed. */
export interface ScreenOwner {
  readonly once: (event: "destroyed", listener: () => void) => unknown
}

export interface VmExec {
  readonly command: string
  readonly timeoutSeconds: number
  /** Returns at once with the pid and log path instead of waiting for the command. */
  readonly background: boolean
}

export class TinyVm extends Context.Service<
  TinyVm,
  {
    /** Whether `Settings.experimental.tinyVm` is on, kept current without a database read. */
    readonly enabled: () => boolean
    readonly get: (threadId: string) => Effect.Effect<ThreadVm>
    /** Creates the thread's VM unless it has one; concurrent calls share one creation. A failure is the `failed` state. */
    readonly start: (threadId: string) => Effect.Effect<ThreadVm>
    readonly stop: (threadId: string) => Effect.Effect<void>
    /** Has no effect unless the VM is running. */
    readonly setControl: (threadId: string, control: VmControl) => Effect.Effect<ThreadVm>
    readonly host: Effect.Effect<VmHostStatus>
    /** Starts the VM if needed and returns its screen as PNG bytes. */
    readonly screenshot: (threadId: string) => Effect.Effect<Uint8Array, VmError>
    /**
     * Starts the VM if needed and performs the actions over VNC. While the user has control it waits until
     * they hand it back and returns `handedBack` without acting, because the screen may have changed.
     */
    readonly act: (threadId: string, actions: ReadonlyArray<VmAction>) => Effect.Effect<"done" | "handedBack", VmError>
    readonly exec: (threadId: string, input: VmExec) => Effect.Effect<ExecResult, VmError>
    /**
     * Connects a side panel view to the running VM's VNC server. Its bytes arrive as `vm.screen.data` pushes,
     * then `vm.screen.closed`.
     */
    readonly openScreen: (threadId: string, streamId: string, owner: ScreenOwner) => Effect.Effect<void, VmError>
    /** Writes bytes to the VNC server in call order. Ignored once the stream has closed. */
    readonly sendScreen: (streamId: string, data: Uint8Array) => Effect.Effect<void>
    readonly closeScreen: (streamId: string) => Effect.Effect<void>
  }
>()("hinacode/TinyVm") {}

const VNC_PORT = 5900
const SCREENSHOT_SCRIPT = "import -window root png:-"
const SCREENSHOT_TIMEOUT_SECONDS = 30
/** About one frame, like terminal output. */
const FLUSH_INTERVAL_MS = 16
const FLUSH_SIZE = 256 * 1024
/** How long control stays with the user after their last view closes, so a view that reconnects keeps it. */
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

/** Ends a socket and waits for the peer to close it, so a server reads everything before the connection drops. */
const endGracefully = (socket: Socket) =>
  Effect.callback<void>((resume) => {
    socket.once("close", () => resume(Effect.void))
    socket.end()
  }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }))

const make = (source: LoginSource) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const events = yield* Events
    const settings = yield* Settings

    const vms = new Map<string, ThreadVm>()
    const creations = new Map<string, Deferred.Deferred<ThreadVm>>()
    /** Agent tools waiting for the user to hand control back, per thread. */
    const waiting = new Map<string, number>()
    const handBacks = new Map<string, Deferred.Deferred<void>>()
    const screens = new Map<string, Screen>()
    const openingScreens = new Set<string>()
    const ownedScreens = new WeakMap<ScreenOwner, Set<string>>()
    let enabled = yield* settings.get.pipe(
      Effect.map((value) => value.experimental.tinyVm),
      Effect.orElseSucceed(() => false),
    )

    const current = (threadId: string) => vms.get(threadId) ?? NONE

    // Socket callbacks run outside any fiber. Forking with the layer's context keeps its clock.
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

    const client = readLogin(source).pipe(Effect.map(sbxClient), Effect.mapError(toVmError))

    const closeScreensOf = (threadId: string) =>
      screens.forEach((screen) => screen.threadId === threadId && screen.socket.destroy())

    /** sbx destroyed the sandbox: the thread has no VM any more. */
    const forget = (threadId: string, sandboxId: string) =>
      Effect.suspend(() => {
        const vm = current(threadId)
        if (vm.status !== "running" || vm.sandboxId !== sandboxId) return Effect.void
        closeScreensOf(threadId)
        return setVm(threadId, NONE)
      })

    const settle = (threadId: string, done: Deferred.Deferred<ThreadVm>, vm: ThreadVm) =>
      Effect.gen(function* () {
        // A stop while starting replaced or removed the creation, and the sandbox has no thread to go to.
        const live = creations.get(threadId) === done
        if (live) {
          creations.delete(threadId)
          yield* setVm(threadId, vm)
        }
        yield* Deferred.succeed(done, live ? vm : NONE)
        return live
      })

    const create = (threadId: string, done: Deferred.Deferred<ThreadVm>) =>
      Effect.gen(function* () {
        if (!enabled) return yield* new VmError({ message: "Tiny VM is off. Turn it on in Settings > Experimental." })
        const sbx = yield* client
        return { sbx, sandbox: yield* sbx.create.pipe(Effect.mapError(toVmError)) }
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) => settle(threadId, done, { status: "failed", message: error.message }),
          onSuccess: ({ sbx, sandbox }) =>
            settle(threadId, done, { status: "running", sandboxId: sandbox.id, control: "agent" }).pipe(
              Effect.tap((live) => (live ? Effect.void : Effect.ignore(sbx.remove(sandbox.id)))),
            ),
        }),
      )

    const start = (threadId: string) =>
      Effect.suspend((): Effect.Effect<ThreadVm> => {
        const vm = current(threadId)
        if (vm.status === "running") return Effect.succeed(vm)
        const pending = creations.get(threadId)
        if (pending) return Deferred.await(pending)
        const done = Deferred.makeUnsafe<ThreadVm>()
        creations.set(threadId, done)
        return setVm(threadId, { status: "starting" }).pipe(
          Effect.andThen(Effect.forkIn(create(threadId, done), scope)),
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
      use: (sbx: SbxClient, sandboxId: string) => Effect.Effect<A, E>,
    ): Effect.Effect<A, VmError> =>
      Effect.gen(function* () {
        const { sandboxId } = yield* ensureRunning(threadId)
        const sbx = yield* client
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
        closeScreensOf(threadId)
        if (vm.status === "none") return
        yield* setVm(threadId, NONE)
        if (vm.status !== "running") return
        yield* client.pipe(
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
                sandboxId: vm.sandboxId,
                control: "user",
                agentWaiting: (waiting.get(threadId) ?? 0) > 0,
              }
            : { status: "running", sandboxId: vm.sandboxId, control: "agent" }
        return Effect.as(setVm(threadId, next), next)
      })

    const perform = (threadId: string, actions: ReadonlyArray<VmAction>) =>
      withSandbox(threadId, (sbx, sandboxId) =>
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
        ),
      )

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

    const host: Effect.Effect<VmHostStatus> = readLogin(source).pipe(
      Effect.map(sbxClient),
      Effect.flatMap((sbx) =>
        sbx.status.pipe(
          Effect.map((status): VmHostStatus => ({ status: "connected", url: sbx.url, ...status })),
          Effect.catch((error) =>
            Effect.succeed<VmHostStatus>({ status: "unreachable", url: sbx.url, message: error.message }),
          ),
        ),
      ),
      Effect.catchTags({
        SbxNotConfiguredError: () => Effect.succeed<VmHostStatus>({ status: "notConfigured" }),
        SbxError: (error) =>
          Effect.succeed<VmHostStatus>({ status: "unreachable", url: source.configPath, message: error.message }),
      }),
    )

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
      // Nobody can hand control back once no view is open, so it goes back to the agent. Moving the screen
      // between the side panel and floating closes one view before the next opens, hence the grace.
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
        openingScreens.add(streamId)
        const sbx = yield* client
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
          enabled = value.experimental.tinyVm
          return was && !enabled ? stopAll : Effect.void
        }),
      ),
      Effect.forkIn(scope),
    )

    // Sandboxes do not outlive the app; sbx's idle timeout catches whatever this misses.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        screens.forEach((screen) => screen.socket.destroy())
        const running = [...vms.values()].flatMap((vm) => (vm.status === "running" ? [vm.sandboxId] : []))
        if (running.length === 0) return
        const sbx = yield* client
        yield* Effect.forEach(running, (id) => Effect.ignore(sbx.remove(id)), { concurrency: "unbounded" })
      }).pipe(Effect.ignore, Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.void })),
    )

    return TinyVm.of({
      enabled: () => enabled,
      get: (threadId) => Effect.sync(() => current(threadId)),
      start,
      stop,
      setControl,
      host,
      screenshot,
      act,
      exec,
      openScreen,
      sendScreen,
      closeScreen,
    })
  })

export const layer = (source: LoginSource) => Layer.effect(TinyVm, make(source))
