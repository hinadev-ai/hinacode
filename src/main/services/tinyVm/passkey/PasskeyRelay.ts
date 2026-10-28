import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Semaphore, Stream } from "effect"
import { defaultSettings, type VmPasskey } from "../../../../shared/domain.ts"
import { Events } from "../../Events.ts"
import { Settings } from "../../Settings.ts"
import { TinyVm } from "../TinyVm.ts"
import { extensionArchive } from "./extension.ts"
import { connectGuest as connectGuestSession, type GuestHandlers, type GuestSession } from "./guest.ts"
import { makeHostChrome } from "./hostChrome.ts"
import {
  ceremonyError,
  notAllowed,
  PasskeyError,
  validateRequest,
  type CeremonyOutcome,
  type CeremonyRequest,
  type GuestRequest,
} from "./protocol.ts"

export interface RelayDeps {
  readonly publish: (threadId: string, passkey: VmPasskey) => Effect.Effect<void>
  readonly isEnabled: () => boolean
  readonly ensureHostStarted: Effect.Effect<void, PasskeyError>
  readonly connectGuest: (threadId: string, handlers: GuestHandlers) => Effect.Effect<GuestSession, PasskeyError>
  readonly runCeremony: (request: CeremonyRequest) => Effect.Effect<CeremonyOutcome>
  readonly cancelCeremony: Effect.Effect<void>
}

export interface RelayCore {
  readonly get: (threadId: string) => Effect.Effect<VmPasskey>
  readonly prepare: (threadId: string) => Effect.Effect<VmPasskey>
  readonly cancel: (threadId: string) => Effect.Effect<void>
  readonly closeAll: Effect.Effect<void>
}

interface Pending {
  readonly request: GuestRequest
  fiber: Fiber.Fiber<void> | undefined
}

interface Session {
  readonly threadId: string
  guest: GuestSession | undefined
  early: Array<GuestRequest>
  pending: Pending | undefined
}

const OFF: VmPasskey = { status: "off" }
const READY: VmPasskey = { status: "ready" }

export const makeRelayCore = (deps: RelayDeps) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const states = new Map<string, VmPasskey>()
    const sessions = new Map<string, Session>()
    const preparing = new Map<string, Deferred.Deferred<VmPasskey>>()
    const ceremonyPermit = yield* Semaphore.make(1)
    const runFork = Effect.runForkWith(yield* Effect.context<never>())

    const current = (threadId: string) => states.get(threadId) ?? OFF

    const setState = (threadId: string, passkey: VmPasskey) =>
      Effect.sync(() => {
        if (passkey.status === "off") states.delete(threadId)
        else states.set(threadId, passkey)
      }).pipe(Effect.andThen(deps.publish(threadId, passkey)))

    const clearPending = (session: Session, requestId: number) =>
      Effect.suspend(() => {
        if (session.pending?.request.requestId !== requestId) return Effect.succeed(false)
        const fiber = session.pending.fiber
        session.pending = undefined
        return Effect.as(fiber === undefined ? Effect.void : Fiber.interrupt(fiber), true)
      })

    const finishCeremony = (session: Session, request: GuestRequest, outcome: CeremonyOutcome) =>
      Effect.gen(function* () {
        if (session.pending?.request.requestId !== request.requestId) return
        session.pending = undefined
        if (session.guest !== undefined) yield* Effect.ignore(session.guest.complete(request, outcome))
        if (sessions.get(session.threadId) === session) yield* setState(session.threadId, READY)
      })

    const handleRequest = (session: Session, request: GuestRequest) =>
      Effect.gen(function* () {
        const guest = session.guest
        if (guest === undefined) {
          session.early.push(request)
          return
        }
        if (session.pending !== undefined) {
          yield* Effect.ignore(
            guest.complete(request, notAllowed("Another passkey request from this VM is already waiting")),
          )
          return
        }
        const validated = validateRequest(request)
        if ("error" in validated) {
          yield* Effect.ignore(guest.complete(request, ceremonyError("SecurityError", validated.error)))
          return
        }
        yield* Effect.logInfo("tiny vm passkey: ceremony requested", validated.rpId, validated.kind)
        const pending: Pending = { request, fiber: undefined }
        session.pending = pending
        yield* setState(session.threadId, {
          status: "pending",
          kind: validated.kind,
          origin: validated.origin,
          rpId: validated.rpId,
        })
        const ceremony = ceremonyPermit.withPermit(deps.runCeremony(validated)).pipe(
          Effect.timeoutOrElse({
            duration: "180 seconds",
            orElse: () => Effect.as(deps.cancelCeremony, notAllowed("No answer came from this Mac in time")),
          }),
          Effect.tap((outcome) => Effect.logInfo("tiny vm passkey: ceremony finished", validated.rpId, outcome.type)),
          Effect.flatMap((outcome) => finishCeremony(session, request, outcome)),
        )
        pending.fiber = yield* Effect.forkIn(ceremony, scope)
      })

    const dropPending = (session: Session, requestId: number) =>
      clearPending(session, requestId).pipe(
        Effect.flatMap((dropped) =>
          dropped && sessions.get(session.threadId) === session
            ? deps.cancelCeremony.pipe(Effect.andThen(setState(session.threadId, READY)))
            : Effect.void,
        ),
      )

    const closeSession = (session: Session, state: VmPasskey) =>
      Effect.gen(function* () {
        if (sessions.get(session.threadId) === session) sessions.delete(session.threadId)
        const fiber = session.pending?.fiber
        session.pending = undefined
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        if (session.guest !== undefined) yield* session.guest.close
        yield* setState(session.threadId, state)
      })

    const handlersFor = (session: Session): GuestHandlers => ({
      onRequest: (request) => runFork(handleRequest(session, request)),
      onCanceled: (requestId) => runFork(dropPending(session, requestId)),
      onTimeout: (requestId) => runFork(dropPending(session, requestId)),
      onClose: () => {
        if (sessions.get(session.threadId) === session) runFork(closeSession(session, OFF))
      },
    })

    const doPrepare = (threadId: string, done: Deferred.Deferred<VmPasskey>) =>
      Effect.gen(function* () {
        if (!deps.isEnabled()) {
          return yield* new PasskeyError({
            message: "Turn on Passkeys from this Mac in Settings > Experimental first.",
          })
        }
        yield* deps.ensureHostStarted
        const session: Session = { threadId, guest: undefined, early: [], pending: undefined }
        sessions.set(threadId, session)
        const guest = yield* deps.connectGuest(threadId, handlersFor(session)).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (sessions.get(threadId) === session) sessions.delete(threadId)
            }),
          ),
        )
        session.guest = guest
        if (sessions.get(threadId) !== session) {
          yield* guest.close
          return OFF
        }
        yield* setState(threadId, READY)
        const early = session.early.splice(0)
        for (const request of early) yield* handleRequest(session, request)
        return current(threadId)
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.gen(function* () {
              preparing.delete(threadId)
              const failed: VmPasskey = { status: "failed", message: error.message }
              yield* setState(threadId, failed)
              yield* Deferred.succeed(done, failed)
            }),
          onSuccess: (state) =>
            Effect.gen(function* () {
              preparing.delete(threadId)
              yield* Deferred.succeed(done, state)
            }),
        }),
      )

    const prepare = (threadId: string) =>
      Effect.suspend((): Effect.Effect<VmPasskey> => {
        if (sessions.has(threadId)) return Effect.succeed(current(threadId))
        const pending = preparing.get(threadId)
        if (pending !== undefined) return Deferred.await(pending)
        const done = Deferred.makeUnsafe<VmPasskey>()
        preparing.set(threadId, done)
        return Effect.forkIn(doPrepare(threadId, done), scope).pipe(Effect.andThen(Deferred.await(done)))
      })

    const cancel = (threadId: string) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId)
        if (session?.pending === undefined || session.guest === undefined) return
        const { request } = session.pending
        session.pending = undefined
        yield* deps.cancelCeremony
        yield* Effect.ignore(session.guest.complete(request, notAllowed("The user cancelled the passkey request")))
        yield* setState(threadId, READY)
      })

    const closeAll = Effect.suspend(() =>
      Effect.forEach([...sessions.values()], (session) => closeSession(session, OFF), {
        concurrency: "unbounded",
        discard: true,
      }),
    )

    return {
      get: (threadId) => Effect.sync(() => current(threadId)),
      prepare,
      cancel,
      closeAll,
    } satisfies RelayCore
  })

export class VmPasskeyRelay extends Context.Service<
  VmPasskeyRelay,
  {
    readonly get: RelayCore["get"]
    readonly prepare: RelayCore["prepare"]
    readonly cancel: RelayCore["cancel"]
  }
>()("hinacode/VmPasskeyRelay") {}

const RELAUNCH_SCRIPT = [
  "pkill -TERM chromium 2>/dev/null || true",
  "for _ in $(seq 20); do pgrep chromium >/dev/null || break; sleep 0.25; done",
  "pkill -KILL chromium 2>/dev/null || true",
  "rm -f ~/.config/chromium/Singleton*",
  "exec chromium --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --load-extension=$HOME/.hinacode/passkey-extension",
].join("\n")

const toPasskeyError = (error: { readonly message: string }) => new PasskeyError({ message: error.message })

const make = (baseDir: string) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const tinyVm = yield* TinyVm
    const settings = yield* Settings
    const events = yield* Events
    const host = yield* makeHostChrome(join(baseDir, "passkey-chrome"))

    const experimental = yield* settings.get.pipe(
      Effect.map((value) => value.experimental),
      Effect.orElseSucceed(() => defaultSettings.experimental),
    )
    let enabled = experimental.tinyVm && experimental.tinyVmPasskeys

    const connectGuest = (threadId: string, handlers: GuestHandlers) =>
      Effect.gen(function* () {
        const vm = yield* tinyVm.start(threadId)
        if (vm.status === "failed") return yield* new PasskeyError({ message: vm.message })
        if (vm.status !== "running") return yield* new PasskeyError({ message: "The VM did not start" })
        const made = yield* tinyVm
          .exec(threadId, { command: "mkdir -p ~/.hinacode", timeoutSeconds: 30, background: false })
          .pipe(Effect.mapError(toPasskeyError))
        if (made.exitCode !== 0) {
          return yield* new PasskeyError({ message: "Could not prepare the VM for the passkey extension" })
        }
        yield* tinyVm.stageArchive(threadId, ".hinacode", extensionArchive()).pipe(Effect.mapError(toPasskeyError))
        const launched = yield* tinyVm
          .exec(threadId, { command: RELAUNCH_SCRIPT, timeoutSeconds: 30, background: true })
          .pipe(Effect.mapError(toPasskeyError))
        if (launched.exitCode !== 0) {
          return yield* new PasskeyError({ message: "Chromium did not restart in the VM with the passkey extension" })
        }
        return yield* connectGuestSession({
          openTunnel: () => tinyVm.openTunnel(threadId, 9222).pipe(Effect.mapError(toPasskeyError)),
          handlers,
        })
      })

    const core: RelayCore = yield* makeRelayCore({
      publish: (threadId, passkey) => events.publish({ type: "vm.passkey.updated", threadId, passkey }),
      isEnabled: () => enabled,
      ensureHostStarted: host.ensureStarted,
      connectGuest,
      runCeremony: host.runCeremony,
      cancelCeremony: host.cancel,
    })

    yield* (yield* settings.changes).pipe(
      Stream.runForEach((value) =>
        Effect.suspend(() => {
          const was = enabled
          enabled = value.experimental.tinyVm && value.experimental.tinyVmPasskeys
          return was && !enabled ? core.closeAll : Effect.void
        }),
      ),
      Effect.forkIn(scope),
    )

    yield* Effect.addFinalizer(() =>
      core.closeAll.pipe(
        Effect.andThen(host.close),
        Effect.ignore,
        Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.void }),
      ),
    )

    return VmPasskeyRelay.of({ get: core.get, prepare: core.prepare, cancel: core.cancel })
  })

export const layer = (baseDir: string) => Layer.effect(VmPasskeyRelay, make(baseDir))
