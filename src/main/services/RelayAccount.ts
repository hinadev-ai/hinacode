import { Clock, Context, Duration, Effect, Exit, Fiber, FiberHandle, Layer, Option, Schedule, Semaphore } from "effect"
import type { RelayAccountStatus } from "../../shared/domain.ts"
import type { RelayHost, RelayMachine } from "../../shared/relayMachines.ts"
import { RemoteAccess } from "../remote/access.ts"
import { type Fetch, Link, RelayError, type RelayLink, relayService } from "../remote/relayService.ts"
import { nowIso } from "./clock.ts"
import { Environments } from "./Environments.ts"
import type { PersistenceError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

export const DEVICE_CREDENTIAL_SECRET = "relay.deviceCredential"

const SYNC_INTERVAL = "5 minutes"
const SIGN_IN_EXPIRED = "The sign-in expired. Try again."

export class RelayAccount extends Context.Service<
  RelayAccount,
  {
    readonly status: Effect.Effect<RelayAccountStatus, PersistenceError>
    readonly signIn: (input: {
      readonly onLink: (link: RelayLink) => Effect.Effect<void>
    }) => Effect.Effect<RelayAccountStatus, RelayError | PersistenceError>
    readonly signOut: Effect.Effect<RelayAccountStatus, PersistenceError>
    readonly sync: Effect.Effect<RelayAccountStatus>
    readonly machines: Effect.Effect<ReadonlyArray<RelayHost>, RelayError | PersistenceError>
    readonly setShown: (input: {
      readonly id: string
      readonly enabled: boolean
    }) => Effect.Effect<ReadonlyArray<RelayHost>, RelayError | PersistenceError>
    readonly removeMachine: (input: {
      readonly id: string
    }) => Effect.Effect<ReadonlyArray<RelayHost>, RelayError | PersistenceError>
    readonly approveOwnLink: (userCode: string) => Effect.Effect<boolean>
  }
>()("hinacode/RelayAccount") {}

export interface RelayAccountOptions {
  readonly serviceUrl: string
  readonly fetch?: Fetch
}

type SignedIn = Extract<RelayAccountStatus, { state: "signedIn" }>

const make = ({ serviceUrl, fetch = globalThis.fetch }: RelayAccountOptions) =>
  Effect.gen(function* () {
    const service = relayService(fetch, serviceUrl)
    const secrets = yield* Secrets
    const environments = yield* Environments
    const self = (yield* RemoteAccess).identity
    const lock = yield* Semaphore.make(1)
    const signingIn = yield* FiberHandle.make<RelayAccountStatus, RelayError | PersistenceError>()
    const nobody: Omit<SignedIn, "state" | "serviceUrl" | "environmentId"> = {
      name: null,
      email: null,
      machines: 0,
      syncedAt: null,
      error: null,
    }
    let last = nobody

    const signedIn = (): SignedIn => ({ state: "signedIn", serviceUrl, environmentId: self.id, ...last })
    const signedOut: RelayAccountStatus = { state: "signedOut" }

    const status = Effect.map(secrets.has(DEVICE_CREDENTIAL_SECRET), (has) => (has ? signedIn() : signedOut))

    const apply = (machines: ReadonlyArray<RelayMachine>) =>
      Effect.gen(function* () {
        const kept = yield* environments.syncRelay(machines)
        last = { ...last, machines: kept, syncedAt: yield* nowIso, error: null }
        return signedIn()
      })

    const refreshProfile = (credential: string) =>
      service.profile(credential).pipe(
        Effect.tap(({ name, email }) =>
          Effect.sync(() => {
            last = { ...last, name, email }
          }),
        ),
        Effect.catch((error) => Effect.logWarning("could not read the relay account", error)),
      )

    const claimUntilApproved = (link: typeof Link.Type) =>
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(Duration.seconds(link.interval))
          if ((yield* Clock.currentTimeMillis) >= link.expiresAt) {
            return yield* new RelayError({ message: SIGN_IN_EXPIRED })
          }
          const claimed = yield* service.claim(link.deviceCode)
          if (Option.isNone(claimed)) continue
          yield* secrets.set(DEVICE_CREDENTIAL_SECRET, claimed.value).pipe(lock.withPermit, Effect.uninterruptible)
          return yield* sync
        }
      })

    const signIn = ({ onLink }: { readonly onLink: (link: RelayLink) => Effect.Effect<void> }) =>
      Effect.gen(function* () {
        const attempt = yield* FiberHandle.run(
          signingIn,
          Effect.gen(function* () {
            const link = yield* service.createSignIn(self.name)
            yield* onLink({ url: link.url, userCode: link.userCode })
            return yield* claimUntilApproved(link)
          }),
        )
        const exit = yield* Fiber.await(attempt)
        return Exit.hasInterrupts(exit) ? yield* status : yield* exit
      })

    const forgetDevice = secrets.get(DEVICE_CREDENTIAL_SECRET).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (credential) =>
            service
              .signOutDevice(credential)
              .pipe(Effect.catch((error) => Effect.logWarning("could not sign out of the relay", error))),
        }),
      ),
      Effect.andThen(secrets.clear(DEVICE_CREDENTIAL_SECRET)),
      Effect.andThen(environments.syncRelay([])),
      Effect.andThen(
        Effect.sync(() => {
          last = nobody
          return signedOut
        }),
      ),
      lock.withPermit,
    )

    const signOut = Effect.andThen(FiberHandle.clear(signingIn), forgetDevice)

    const sync = secrets.get(DEVICE_CREDENTIAL_SECRET).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<RelayAccountStatus>(signedOut),
          onSome: (credential) =>
            service.machines(credential).pipe(
              Effect.tap(() => refreshProfile(credential)),
              Effect.flatMap(({ machines }) => apply(machines)),
            ),
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          last = { ...last, error: error.message }
          return signedIn()
        }),
      ),
      lock.withPermit,
    )

    const storedCredential = Effect.flatMap(
      secrets.get(DEVICE_CREDENTIAL_SECRET),
      Option.match({
        onNone: () => Effect.fail(new RelayError({ message: "Sign in to the relay in Settings > Connections first." })),
        onSome: Effect.succeed,
      }),
    )

    const machines = Effect.flatMap(storedCredential, service.hosts)

    const changeMachines = (change: (token: string) => Effect.Effect<void, RelayError | PersistenceError>) =>
      Effect.gen(function* () {
        const token = yield* storedCredential
        yield* change(token)
        yield* sync
        return yield* service.hosts(token)
      })

    const setShown = ({ id, enabled }: { readonly id: string; readonly enabled: boolean }) =>
      changeMachines((token) => service.setShown(token, id, enabled))

    const removeMachine = ({ id }: { readonly id: string }) =>
      changeMachines((token) =>
        Effect.gen(function* () {
          const hosts = yield* service.hosts(token)
          if (hosts.some((host) => host.id === id && host.environmentId === self.id)) {
            return yield* new RelayError({
              message: "To unlink this machine, sign out.",
            })
          }
          yield* service.removeHost(token, id)
        }),
      )

    const approveOwnLink = (userCode: string) =>
      secrets.get(DEVICE_CREDENTIAL_SECRET).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (token) => Effect.as(service.approveLink(token, userCode), true),
          }),
        ),
        Effect.catch((error) =>
          Effect.as(Effect.logWarning("could not approve this machine's relay link", error), false),
        ),
      )

    yield* Effect.forkScoped(sync.pipe(Effect.repeat(Schedule.spaced(SYNC_INTERVAL))))

    return RelayAccount.of({
      status,
      signIn,
      signOut,
      sync,
      machines,
      setShown,
      removeMachine,
      approveOwnLink,
    })
  })

export const layer = (options: RelayAccountOptions) => Layer.effect(RelayAccount, make(options))
