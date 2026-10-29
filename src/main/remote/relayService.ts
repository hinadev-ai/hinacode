import { Duration, Effect, Option, Predicate, Schema } from "effect"
import { PendingLink, RelayHostList, RelayMachineList } from "../../shared/relayMachines.ts"

export const EXPIRED = "The sign-in link expired. Turn on the relay again."

const CALL_TIMEOUT = Duration.seconds(30)

export class RelayError extends Schema.TaggedError<RelayError>()("RelayError", { message: Schema.String }) {}

export type Fetch = (input: URL, init: RequestInit) => Promise<Response>

export interface RelayLink {
  readonly url: string
  readonly userCode: string
}

export const Link = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  url: Schema.String,
  interval: Schema.Number,
  expiresAt: Schema.Number,
})
const Claimed = Schema.Struct({ credential: Schema.String })
const Tunnel = Schema.Struct({ hostname: Schema.String, connectorToken: Schema.String })
const ServiceFailure = Schema.Struct({ error: Schema.String })

const forgotten = () =>
  new RelayError({ message: "The relay service no longer knows this machine. Remove the relay and turn it on again." })

const refusedOwnerToken = () =>
  new RelayError({
    message: "The relay refused the owner token. Copy the current one from the relay page and sign in again.",
  })

const describe = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") && typeof cause.message === "string" ? cause.message : String(cause)

const failed = (action: string, { status, body }: { status: number; body: unknown }) => {
  const reason = Option.match(Schema.decodeUnknownOption(ServiceFailure)(body), {
    onNone: () => `HTTP ${status}`,
    onSome: ({ error }) => error,
  })
  return new RelayError({ message: `The relay service could not ${action}: ${reason}` })
}

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  action: string,
  schema: S,
  answer: { status: number; body: unknown },
) =>
  answer.status >= 200 && answer.status < 300
    ? Schema.decodeUnknownEffect(schema)(answer.body).pipe(
        Effect.mapError(
          () =>
            new RelayError({ message: `The relay service answered in an unexpected shape when asked to ${action}.` }),
        ),
      )
    : Effect.fail(failed(action, answer))

const succeeded = (action: string) => (answer: { status: number; body: unknown }) =>
  answer.status < 300 ? Effect.void : Effect.fail(failed(action, answer))

const linkPath = (userCode: string) => `/v1/links/${encodeURIComponent(userCode)}`

export const relayService = (fetch: Fetch, serviceUrl: string) => {
  const call = (action: string, method: string, path: string, options: { body?: unknown; credential?: string }) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(new URL(path, serviceUrl), {
            method,
            headers: {
              "Content-Type": "application/json",
              ...(options.credential !== undefined && { Authorization: `Bearer ${options.credential}` }),
            },
            ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
            signal,
          }),
        catch: (cause) =>
          new RelayError({ message: `Cannot reach the relay service at ${serviceUrl}: ${describe(cause)}.` }),
      })
      const body: unknown = yield* Effect.promise(() => response.json().catch(() => null))
      return { status: response.status, body }
    }).pipe(
      Effect.timeoutOrElse({
        duration: CALL_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RelayError({
              message: `The relay service at ${serviceUrl} did not answer within ${Duration.toSeconds(CALL_TIMEOUT)} seconds.`,
            }),
          ),
      }),
    )

  const asOwner = (action: string, method: string, path: string, ownerToken: string, body?: unknown) =>
    call(action, method, path, { credential: ownerToken, body }).pipe(
      Effect.flatMap((answer) => (answer.status === 401 ? Effect.fail(refusedOwnerToken()) : Effect.succeed(answer))),
    )

  return {
    createLink: (environmentId: string, name: string) =>
      call("start linking", "POST", "/v1/links", { body: { environmentId, name } }).pipe(
        Effect.flatMap((answer) => decode("start linking", Link, answer)),
      ),
    claim: (deviceCode: string) =>
      call("finish linking", "POST", "/v1/links/claim", { body: { deviceCode } }).pipe(
        Effect.flatMap((answer) => {
          if (answer.status === 202) return Effect.succeedNone
          if (answer.status === 410) return Effect.fail(new RelayError({ message: EXPIRED }))
          return Effect.map(decode("finish linking", Claimed, answer), ({ credential }) => Option.some(credential))
        }),
      ),
    putTunnel: (credential: string, origin: string) =>
      call("route the tunnel", "PUT", "/v1/tunnel", { body: { origin }, credential }).pipe(
        Effect.flatMap((answer) =>
          answer.status === 401 ? Effect.fail(forgotten()) : decode("route the tunnel", Tunnel, answer),
        ),
      ),
    publishPairing: (credential: string, pairing: { hosts: ReadonlyArray<string>; port: number; token: string }) =>
      call("publish this machine's pairing", "PUT", "/v1/host/pairing", { body: pairing, credential }).pipe(
        Effect.flatMap((answer) => {
          if (answer.status === 401) return Effect.fail(forgotten())
          if (answer.status >= 300) return Effect.fail(failed("publish this machine's pairing", answer))
          return Effect.void
        }),
      ),
    machines: (ownerToken: string) =>
      asOwner("list your machines", "GET", "/v1/machines", ownerToken).pipe(
        Effect.flatMap((answer) => decode("list your machines", RelayMachineList, answer)),
      ),
    hosts: (ownerToken: string) =>
      asOwner("list your machines", "GET", "/v1/hosts", ownerToken).pipe(
        Effect.flatMap((answer) => decode("list your machines", RelayHostList, answer)),
        Effect.map(({ hosts }) => hosts),
      ),
    setShown: (ownerToken: string, id: string, enabled: boolean) =>
      asOwner("change the machine", "PATCH", `/v1/hosts/${encodeURIComponent(id)}`, ownerToken, { enabled }).pipe(
        Effect.flatMap(succeeded("change the machine")),
      ),
    removeHost: (ownerToken: string, id: string) =>
      asOwner("remove the machine", "DELETE", `/v1/hosts/${encodeURIComponent(id)}`, ownerToken).pipe(
        Effect.flatMap(succeeded("remove the machine")),
      ),
    pendingLink: (ownerToken: string, userCode: string) =>
      asOwner("find that link code", "GET", linkPath(userCode), ownerToken).pipe(
        Effect.flatMap((answer) => decode("find that link code", PendingLink, answer)),
      ),
    approveLink: (ownerToken: string, userCode: string) =>
      asOwner("approve the link", "POST", linkPath(userCode), ownerToken).pipe(
        Effect.flatMap(succeeded("approve the link")),
      ),
    deleteHost: (credential: string) =>
      call("unlink this machine", "DELETE", "/v1/host", { credential }).pipe(
        Effect.flatMap((answer) =>
          answer.status < 300 || answer.status === 401 || answer.status === 404
            ? Effect.void
            : Effect.fail(failed("unlink this machine", answer)),
        ),
      ),
  }
}
