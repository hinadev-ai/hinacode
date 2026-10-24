import { Context, Effect, Layer, Option, Schedule, Semaphore } from "effect"
import type { RelayAccountStatus } from "../../shared/domain.ts"
import type { PendingLink, RelayHost, RelayMachine } from "../../shared/relayMachines.ts"
import { RemoteAccess } from "../remote/access.ts"
import { type Fetch, RelayError, relayService } from "../remote/relayService.ts"
import { nowIso } from "./clock.ts"
import { Environments } from "./Environments.ts"
import type { PersistenceError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

export const OWNER_TOKEN_SECRET = "relay.ownerToken"

const SYNC_INTERVAL = "5 minutes"
const PUBLISH_POLL = "1 second"
const PUBLISH_WAIT = "1 minute"

/**
 * This desktop's sign-in to the relay with the owner token. While signed in, every machine the owner shows on
 * their devices is an environment here, synced at start, every five minutes and on demand.
 */
export class RelayAccount extends Context.Service<
  RelayAccount,
  {
    readonly status: Effect.Effect<RelayAccountStatus, PersistenceError>
    /** Keeps the owner token only once the relay listed the machines with it. */
    readonly signIn: (ownerToken: string) => Effect.Effect<RelayAccountStatus, RelayError | PersistenceError>
    /** Forgets the owner token and drops every environment the relay added. */
    readonly signOut: Effect.Effect<RelayAccountStatus, PersistenceError>
    /** Never fails. A failed sync keeps every environment and says why in `error`. */
    readonly sync: Effect.Effect<RelayAccountStatus>
    /** Every machine linked to the relay, shown on the owner's devices or not. */
    readonly machines: Effect.Effect<ReadonlyArray<RelayHost>, RelayError | PersistenceError>
    /** Turns Show on my devices on or off, syncs, and answers the fresh list. */
    readonly setShown: (input: {
      readonly id: string
      readonly enabled: boolean
    }) => Effect.Effect<ReadonlyArray<RelayHost>, RelayError | PersistenceError>
    /** Unlinks another machine from the relay, syncs, and answers the fresh list. */
    readonly removeMachine: (input: {
      readonly id: string
    }) => Effect.Effect<ReadonlyArray<RelayHost>, RelayError | PersistenceError>
    /** The machine waiting on a link code. */
    readonly pendingLink: (userCode: string) => Effect.Effect<PendingLink, RelayError | PersistenceError>
    /**
     * Approves a link code, waits up to a minute for that machine to publish its pairing, syncs, and answers the
     * fresh list. A machine that has not published by then still shows, as not published yet.
     */
    readonly approveLink: (userCode: string) => Effect.Effect<ReadonlyArray<RelayHost>, RelayError | PersistenceError>
    /** Approves this desktop's own link with the owner token. False when signed out or the approval failed. */
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
    let last: Omit<SignedIn, "state" | "serviceUrl" | "environmentId"> = { machines: 0, syncedAt: null, error: null }

    const signedIn = (): SignedIn => ({ state: "signedIn", serviceUrl, environmentId: self.id, ...last })
    const signedOut: RelayAccountStatus = { state: "signedOut" }

    const status = Effect.map(secrets.has(OWNER_TOKEN_SECRET), (has) => (has ? signedIn() : signedOut))

    const apply = (machines: ReadonlyArray<RelayMachine>) =>
      Effect.gen(function* () {
        const kept = yield* environments.syncRelay(machines)
        last = { machines: kept, syncedAt: yield* nowIso, error: null }
        return signedIn()
      })

    const signIn = (ownerToken: string) =>
      service.machines(ownerToken).pipe(
        Effect.tap(() => secrets.set(OWNER_TOKEN_SECRET, ownerToken)),
        Effect.flatMap(({ machines }) => apply(machines)),
        lock.withPermit,
      )

    const signOut = secrets.clear(OWNER_TOKEN_SECRET).pipe(
      Effect.andThen(environments.syncRelay([])),
      Effect.andThen(
        Effect.sync(() => {
          last = { machines: 0, syncedAt: null, error: null }
          return signedOut
        }),
      ),
      lock.withPermit,
    )

    const sync = secrets.get(OWNER_TOKEN_SECRET).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<RelayAccountStatus>(signedOut),
          onSome: (ownerToken) => service.machines(ownerToken).pipe(Effect.flatMap(({ machines }) => apply(machines))),
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

    const ownerToken = Effect.flatMap(
      secrets.get(OWNER_TOKEN_SECRET),
      Option.match({
        onNone: () =>
          Effect.fail(new RelayError({ message: "Sign in to the relay in Settings > Environments first." })),
        onSome: Effect.succeed,
      }),
    )

    const machines = Effect.flatMap(ownerToken, service.hosts)

    /** Changes the relay's list, then syncs so this desktop's environments match it at once. */
    const changeMachines = (change: (token: string) => Effect.Effect<void, RelayError | PersistenceError>) =>
      Effect.gen(function* () {
        const token = yield* ownerToken
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
          // Deleting this desktop's tunnel from under it would leave its relay setting pointing at nothing.
          if (hosts.some((host) => host.id === id && host.environmentId === self.id)) {
            return yield* new RelayError({
              message: "To unlink this machine, use Remove relay in Settings > Remote.",
            })
          }
          yield* service.removeHost(token, id)
        }),
      )

    const pendingLink = (userCode: string) =>
      Effect.flatMap(ownerToken, (token) => service.pendingLink(token, userCode))

    const approveLink = (userCode: string) =>
      Effect.gen(function* () {
        const token = yield* ownerToken
        const { environmentId } = yield* service.pendingLink(token, userCode)
        yield* service.approveLink(token, userCode)
        // The machine claims its credential every five seconds, then routes its tunnel and publishes its pairing.
        yield* service.hosts(token).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(PUBLISH_POLL),
            until: (hosts) => hosts.some((host) => host.environmentId === environmentId && host.published),
          }),
          Effect.timeoutOption(PUBLISH_WAIT),
        )
        yield* sync
        return yield* service.hosts(token)
      })

    const approveOwnLink = (userCode: string) =>
      secrets.get(OWNER_TOKEN_SECRET).pipe(
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
      pendingLink,
      approveLink,
      approveOwnLink,
    })
  })

export const layer = (options: RelayAccountOptions) => Layer.effect(RelayAccount, make(options))
