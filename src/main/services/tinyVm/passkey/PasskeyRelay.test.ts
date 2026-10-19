import { Context, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import type { VmPasskey } from "../../../../shared/domain.ts"
import type { GuestHandlers, GuestSession } from "./guest.ts"
import { makeRelayCore, type RelayCore, type RelayDeps } from "./PasskeyRelay.ts"
import { PasskeyError, type CeremonyOutcome, type CeremonyRequest, type GuestRequest } from "./protocol.ts"

class Core extends Context.Service<Core, RelayCore>()("test/PasskeyCore") {}

interface Harness {
  readonly core: RelayCore
  readonly published: Array<VmPasskey>
  readonly completes: Array<{ readonly request: GuestRequest; readonly outcome: CeremonyOutcome }>
  readonly ceremonies: Array<CeremonyRequest>
  readonly handlers: () => GuestHandlers
  readonly cancelledCeremonies: () => number
  readonly waitFor: (check: () => boolean) => Promise<void>
  readonly dispose: () => Promise<void>
}

const makeHarness = async (
  overrides: {
    readonly enabled?: boolean
    readonly ensureHostStarted?: RelayDeps["ensureHostStarted"]
    readonly runCeremony?: RelayDeps["runCeremony"]
  } = {},
): Promise<Harness> => {
  const published: Array<VmPasskey> = []
  const completes: Harness["completes"] = []
  const ceremonies: Array<CeremonyRequest> = []
  let captured: GuestHandlers | undefined
  let cancelled = 0
  let waiters: Array<() => void> = []
  const notify = () => {
    const current = waiters
    waiters = []
    current.forEach((wake) => wake())
  }
  const guest: GuestSession = {
    complete: (request, outcome) =>
      Effect.sync(() => {
        completes.push({ request, outcome })
        notify()
      }),
    close: Effect.void,
  }
  const deps: RelayDeps = {
    publish: (_threadId, passkey) =>
      Effect.sync(() => {
        published.push(passkey)
        notify()
      }),
    isEnabled: () => overrides.enabled ?? true,
    ensureHostStarted: overrides.ensureHostStarted ?? Effect.void,
    connectGuest: (_threadId, handlers) =>
      Effect.sync(() => {
        captured = handlers
        return guest
      }),
    runCeremony:
      overrides.runCeremony ??
      ((request) =>
        Effect.sync(() => {
          ceremonies.push(request)
          return { type: "ok", responseJson: "{}" } satisfies CeremonyOutcome
        })),
    cancelCeremony: Effect.sync(() => {
      cancelled++
    }),
  }
  const runtime = ManagedRuntime.make(Layer.effect(Core, makeRelayCore(deps)))
  const core = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Core
    }),
  )
  return {
    core,
    published,
    completes,
    ceremonies,
    handlers: () => {
      if (captured === undefined) throw new Error("guest never connected")
      return captured
    },
    cancelledCeremonies: () => cancelled,
    waitFor: async (check) => {
      while (!check()) await new Promise<void>((resolve) => waiters.push(resolve))
    },
    dispose: () => runtime.dispose(),
  }
}

const ask = (harness: Harness, overrides: Partial<GuestRequest> = {}) =>
  harness.handlers().onRequest({
    kind: "get",
    requestId: 7,
    origin: "https://github.com",
    requestDetailsJson: JSON.stringify({ rpId: "github.com", challenge: "YQ" }),
    ...overrides,
  })

const prepare = (harness: Harness) => Effect.runPromise(harness.core.prepare("thread-1"))

describe("passkey relay core", () => {
  it("lands in failed with a plain message while the toggle is off", async () => {
    const harness = await makeHarness({ enabled: false })
    try {
      expect(await prepare(harness)).toMatchObject({ status: "failed", message: expect.stringContaining("Settings") })
    } finally {
      await harness.dispose()
    }
  })

  it("lands in failed when Chrome is unusable, before touching the VM", async () => {
    const harness = await makeHarness({
      ensureHostStarted: Effect.fail(new PasskeyError({ message: "Google Chrome was not found on this Mac" })),
    })
    try {
      expect(await prepare(harness)).toStrictEqual({
        status: "failed",
        message: "Google Chrome was not found on this Mac",
      })
    } finally {
      await harness.dispose()
    }
  })

  it("carries an approved ceremony back to the VM page and returns to ready", async () => {
    const harness = await makeHarness()
    try {
      expect(await prepare(harness)).toStrictEqual({ status: "ready" })
      ask(harness)
      await harness.waitFor(() => harness.completes.length === 1)
      expect(harness.completes[0]?.outcome).toStrictEqual({ type: "ok", responseJson: "{}" })
      expect(harness.ceremonies[0]).toMatchObject({ origin: "https://github.com", rpId: "github.com" })
      expect(harness.published).toContainEqual({
        status: "pending",
        kind: "get",
        origin: "https://github.com",
        rpId: "github.com",
      })
      expect(await Effect.runPromise(harness.core.get("thread-1"))).toStrictEqual({ status: "ready" })
    } finally {
      await harness.dispose()
    }
  })

  it("rejects a request for an rpId the origin may not claim, without a ceremony", async () => {
    const harness = await makeHarness()
    try {
      await prepare(harness)
      ask(harness, { origin: "https://evil.example" })
      await harness.waitFor(() => harness.completes.length === 1)
      expect(harness.completes[0]?.outcome).toMatchObject({ type: "error", name: "SecurityError" })
      expect(harness.ceremonies).toStrictEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it("refuses a second request while one ceremony is waiting on the user", async () => {
    const gate = Deferred.makeUnsafe<CeremonyOutcome>()
    const harness = await makeHarness({ runCeremony: () => Deferred.await(gate) })
    try {
      await prepare(harness)
      ask(harness)
      await harness.waitFor(() => harness.published.some((state) => state.status === "pending"))
      ask(harness, { requestId: 8 })
      await harness.waitFor(() => harness.completes.length === 1)
      expect(harness.completes[0]).toMatchObject({
        request: { requestId: 8 },
        outcome: { type: "error", name: "NotAllowedError" },
      })
      Deferred.doneUnsafe(gate, Exit.succeed({ type: "ok", responseJson: "{}" }))
      await harness.waitFor(() => harness.completes.length === 2)
    } finally {
      await harness.dispose()
    }
  })

  it("cancel completes the VM request as a dismissed prompt and closes the ceremony", async () => {
    const gate = Deferred.makeUnsafe<CeremonyOutcome>()
    const harness = await makeHarness({ runCeremony: () => Deferred.await(gate) })
    try {
      await prepare(harness)
      ask(harness)
      await harness.waitFor(() => harness.published.some((state) => state.status === "pending"))
      await Effect.runPromise(harness.core.cancel("thread-1"))
      expect(harness.cancelledCeremonies()).toBe(1)
      expect(harness.completes[0]?.outcome).toMatchObject({ type: "error", name: "NotAllowedError" })
      expect(await Effect.runPromise(harness.core.get("thread-1"))).toStrictEqual({ status: "ready" })
      Deferred.doneUnsafe(gate, Exit.succeed({ type: "ok", responseJson: "{}" }))
    } finally {
      await harness.dispose()
    }
  })
})
