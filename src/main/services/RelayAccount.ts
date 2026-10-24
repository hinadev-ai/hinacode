import { Context, Effect, Layer, Option, Schedule, Semaphore } from "effect"
import type { RelayAccountStatus } from "../../shared/domain.ts"
import type { RelayMachine } from "../../shared/relayMachines.ts"
import { type Fetch, type RelayError, relayService } from "../remote/relayService.ts"
import { nowIso } from "./clock.ts"
import { Environments } from "./Environments.ts"
import type { PersistenceError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

export const OWNER_TOKEN_SECRET = "relay.ownerToken"

const SYNC_INTERVAL = "5 minutes"

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
    const lock = yield* Semaphore.make(1)
    let last: Omit<SignedIn, "state" | "serviceUrl"> = { machines: 0, syncedAt: null, error: null }

    const signedIn = (): SignedIn => ({ state: "signedIn", serviceUrl, ...last })
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

    yield* Effect.forkScoped(sync.pipe(Effect.repeat(Schedule.spaced(SYNC_INTERVAL))))

    return RelayAccount.of({ status, signIn, signOut, sync })
  })

export const layer = (options: RelayAccountOptions) => Layer.effect(RelayAccount, make(options))
