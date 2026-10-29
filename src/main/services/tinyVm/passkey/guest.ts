import { Effect, Schedule } from "effect"
import { attachToTarget, browserSocketUrl, CdpConnection, listTargets } from "./cdp.ts"
import { startForward, type Forward, type TunnelSocket } from "./forward.ts"
import {
  decodeGuestMessage,
  PasskeyError,
  type CeremonyOutcome,
  type GuestMessage,
  type GuestRequest,
} from "./protocol.ts"

export interface GuestHandlers {
  readonly onRequest: (request: GuestRequest) => void
  readonly onCanceled: (requestId: number) => void
  readonly onTimeout: (requestId: number) => void
  readonly onClose: () => void
}

export interface GuestSession {
  readonly complete: (request: GuestRequest, outcome: CeremonyOutcome) => Effect.Effect<void, PasskeyError>
  readonly close: Effect.Effect<void>
}

const BINDING = "__hinacodePasskeyRequest"

const findWorkerSession = (connection: CdpConnection, baseUrl: string) =>
  listTargets(baseUrl).pipe(
    Effect.flatMap((targets) => {
      const worker = targets.find((target) => target.type === "service_worker" && target.url.endsWith("/background.js"))
      return worker === undefined
        ? Effect.fail(new PasskeyError({ message: "The passkey extension did not start in the VM browser" }))
        : attachToTarget(connection, worker.id)
    }),
  )

const untilReady = <A>(effect: Effect.Effect<A, PasskeyError>, message: string) =>
  effect.pipe(
    Effect.retry({ schedule: Schedule.spaced("500 millis").pipe(Schedule.upTo({ duration: "20 seconds" })) }),
    Effect.mapError(() => new PasskeyError({ message })),
  )

const routeMessage = (handlers: GuestHandlers) => (params: unknown) => {
  if (typeof params !== "object" || params === null || !("payload" in params)) return
  const decoded = decodeGuestMessage((params as { payload: unknown }).payload)
  if (decoded._tag === "None") return
  const message: GuestMessage = decoded.value
  switch (message.type) {
    case "request":
      handlers.onRequest(message)
      return
    case "canceled":
      handlers.onCanceled(message.requestId)
      return
    case "timeout":
      handlers.onTimeout(message.requestId)
      return
  }
}

// FIXME: Chromium keeps the extension worker alive only while a DevTools session is attached
export const connectGuest = (args: {
  readonly openTunnel: () => Effect.Effect<TunnelSocket, PasskeyError>
  readonly handlers: GuestHandlers
}): Effect.Effect<GuestSession, PasskeyError> =>
  Effect.gen(function* () {
    const forward: Forward = yield* startForward(args.openTunnel)
    const cleanup = (connection?: CdpConnection) =>
      Effect.sync(() => connection?.close()).pipe(Effect.andThen(forward.close))
    const connection = yield* untilReady(
      browserSocketUrl(forward.baseUrl).pipe(Effect.flatMap(CdpConnection.connect)),
      "The VM browser did not open its DevTools port. The sbx template may be too old for passkeys.",
    ).pipe(Effect.tapError(() => cleanup()))
    const sessionId = yield* untilReady(
      findWorkerSession(connection, forward.baseUrl),
      "The passkey extension did not start in the VM browser",
    ).pipe(Effect.tapError(() => cleanup(connection)))

    let closed = false
    connection.onClose = () => {
      if (closed) return
      closed = true
      args.handlers.onClose()
    }
    connection.on("Runtime.bindingCalled", routeMessage(args.handlers))
    yield* connection.call("Runtime.enable", {}, sessionId).pipe(Effect.tapError(() => cleanup(connection)))
    yield* connection
      .call("Runtime.addBinding", { name: BINDING }, sessionId)
      .pipe(Effect.tapError(() => cleanup(connection)))
    const armed = yield* connection
      .evaluate(sessionId, "globalThis.__hinacodeArm()", true)
      .pipe(Effect.tapError(() => cleanup(connection)))
    if (armed !== true) {
      yield* cleanup(connection)
      return yield* new PasskeyError({ message: "The passkey extension refused to arm in the VM browser" })
    }

    const complete = (request: GuestRequest, outcome: CeremonyOutcome) => {
      const payload = JSON.stringify({
        kind: request.kind,
        requestId: request.requestId,
        ...(outcome.type === "ok"
          ? { responseJson: outcome.responseJson }
          : { error: { name: outcome.name, message: outcome.message } }),
      })
      return connection
        .evaluate(sessionId, `globalThis.__hinacodeComplete(${JSON.stringify(payload)})`)
        .pipe(Effect.asVoid)
    }
    const close = Effect.suspend(() => {
      if (closed) return cleanup(connection)
      closed = true
      return connection
        .evaluate(sessionId, "globalThis.__hinacodeDisarm()", true)
        .pipe(
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
          Effect.ignore,
          Effect.andThen(cleanup(connection)),
        )
    })
    return { complete, close } satisfies GuestSession
  })
