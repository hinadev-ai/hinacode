import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Context, Duration, Effect, Exit, Fiber, FiberHandle, Layer, Option, Schedule, Semaphore } from "effect"
import type { RelayAccountStatus } from "../../shared/domain.ts"
import type { RelayHost, RelayMachine } from "../../shared/relayMachines.ts"
import { RemoteAccess } from "../remote/access.ts"
import { type Fetch, RelayError, relayService } from "../remote/relayService.ts"
import { nowIso } from "./clock.ts"
import { Environments } from "./Environments.ts"
import type { PersistenceError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

const DEVICE_CREDENTIAL_SECRET = "relay.deviceCredential"

const SYNC_INTERVAL = "5 minutes"
const SIGN_IN_EXPIRED = "The sign-in expired. Try again."
const SIGN_IN_TIMEOUT = Duration.minutes(10)

export class RelayAccount extends Context.Service<
  RelayAccount,
  {
    readonly status: Effect.Effect<RelayAccountStatus, PersistenceError>
    readonly signIn: (input: {
      readonly openUrl: (url: string) => Effect.Effect<void>
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

interface RelayAccountOptions {
  readonly serviceUrl: string
  readonly fetch?: Fetch
}

type SignedIn = Extract<RelayAccountStatus, { state: "signedIn" }>

const listenForSignInCode = (signedInPage: URL) =>
  Effect.gen(function* () {
    const received = Promise.withResolvers<string>()
    let answered = false
    const listening = yield* Effect.acquireRelease(
      Effect.callback<Server, RelayError>((resume) => {
        const server = createServer((request, response) => {
          const url = URL.parse(request.url ?? "/", "http://127.0.0.1")
          if (url === null) return void response.writeHead(400).end()
          const code = url.searchParams.get("code")
          if (answered || url.pathname !== "/callback" || !code) return void response.writeHead(404).end()
          answered = true
          response.writeHead(302, { Location: signedInPage.href }).end(() => received.resolve(code))
        })
        server.once("error", (cause) =>
          resume(Effect.fail(new RelayError({ message: `Cannot wait for the sign-in: ${cause.message}` }))),
        )
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
      }),
      (stopping) =>
        Effect.callback<void>((resume) => {
          stopping.close(() => resume(Effect.void))
          stopping.closeAllConnections()
        }),
    )
    return {
      redirectUri: `http://127.0.0.1:${(listening.address() as AddressInfo).port}/callback`,
      code: Effect.promise(() => received.promise),
    }
  })

const AVATAR_MAX_BYTES = 256 * 1024

const downloadAvatar = (fetch: Fetch, imageUrl: string) =>
  Effect.gen(function* () {
    const url = URL.parse(imageUrl)
    if (url?.protocol !== "https:") return yield* new RelayError({ message: "The avatar is not an https URL." })
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { signal }),
      catch: () => new RelayError({ message: "Cannot download the avatar." }),
    })
    const type = response.headers.get("Content-Type") ?? ""
    if (!response.ok || !type.startsWith("image/")) {
      return yield* new RelayError({ message: `The avatar answered HTTP ${response.status} with ${type}.` })
    }
    const bytes = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: () => new RelayError({ message: "Cannot download the avatar." }),
    })
    if (bytes.byteLength > AVATAR_MAX_BYTES) return yield* new RelayError({ message: "The avatar is too large." })
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`
  }).pipe(Effect.timeout(Duration.seconds(30)))

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
      avatar: null,
      machines: 0,
      syncedAt: null,
      error: null,
    }
    let last = nobody
    let avatarUrl: string | null = null

    const signedIn = (): SignedIn => ({ state: "signedIn", serviceUrl, environmentId: self.id, ...last })
    const signedOut: RelayAccountStatus = { state: "signedOut" }

    const status = Effect.map(secrets.has(DEVICE_CREDENTIAL_SECRET), (has) => (has ? signedIn() : signedOut))

    const apply = (machines: ReadonlyArray<RelayMachine>) =>
      Effect.gen(function* () {
        const kept = yield* environments.syncRelay(machines)
        last = { ...last, machines: kept, syncedAt: yield* nowIso, error: null }
        return signedIn()
      })

    const refreshAvatar = (imageUrl: string | null) =>
      imageUrl === avatarUrl
        ? Effect.void
        : Effect.gen(function* () {
            const avatar = imageUrl === null ? null : yield* downloadAvatar(fetch, imageUrl)
            last = { ...last, avatar }
            avatarUrl = imageUrl
          })

    const refreshProfile = (credential: string) =>
      service.profile(credential).pipe(
        Effect.tap(({ name, email }) =>
          Effect.sync(() => {
            last = { ...last, name, email }
          }),
        ),
        Effect.flatMap(({ imageUrl }) => refreshAvatar(imageUrl)),
        Effect.catch((error) => Effect.logWarning("could not read the relay account", error)),
      )

    const receiveSignInCode = (openUrl: (url: string) => Effect.Effect<void>, codeChallenge: string) =>
      Effect.gen(function* () {
        const listener = yield* listenForSignInCode(new URL("/signed-in", serviceUrl))
        const page = new URL("/sign-in", serviceUrl)
        page.searchParams.set("redirect_uri", listener.redirectUri)
        page.searchParams.set("code_challenge", codeChallenge)
        page.searchParams.set("name", self.name)
        yield* openUrl(page.href)
        return yield* listener.code
      }).pipe(
        Effect.timeoutOrElse({
          duration: SIGN_IN_TIMEOUT,
          orElse: () => Effect.fail(new RelayError({ message: SIGN_IN_EXPIRED })),
        }),
        Effect.scoped,
      )

    const signInThroughBrowser = (openUrl: (url: string) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        const codeVerifier = randomBytes(32).toString("base64url")
        const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
        const code = yield* receiveSignInCode(openUrl, codeChallenge)
        const credential = yield* service.exchangeSignInCode(code, codeVerifier)
        yield* secrets.set(DEVICE_CREDENTIAL_SECRET, credential).pipe(lock.withPermit, Effect.uninterruptible)
        return yield* sync
      })

    const signIn = ({ openUrl }: { readonly openUrl: (url: string) => Effect.Effect<void> }) =>
      Effect.gen(function* () {
        const attempt = yield* FiberHandle.run(signingIn, signInThroughBrowser(openUrl))
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
          avatarUrl = null
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
