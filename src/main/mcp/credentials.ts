import { randomBytes, timingSafeEqual } from "node:crypto"
import { Context, Deferred, Effect, Layer, Option } from "effect"
import type { McpConnection } from "../../shared/agent.ts"

const BEARER = "Bearer "

/**
 * The per-thread bearer credentials of the built-in MCP server, `<threadId>.<secret>`. The credential
 * alone decides which thread a call acts as. This is its own service so the agent runner can hand a
 * credential to a turn while the server's tools call back into the runner.
 */
export class McpCredentials extends Context.Service<
  McpCredentials,
  {
    /** Issues the thread's credential on first use; it stays valid while the thread exists. Waits for the server to listen. */
    readonly connectionFor: (threadId: string) => Effect.Effect<McpConnection>
    /** The thread an `Authorization` header was issued for; the comparison is constant-time per thread. */
    readonly authenticate: (authorization: string | undefined) => Option.Option<string>
    /** Called once by the server when it knows its URL. */
    readonly listening: (url: string) => Effect.Effect<void>
  }
>()("hinacode/McpCredentials") {}

const make = Effect.gen(function* () {
  const secrets = new Map<string, Buffer>()
  const url = yield* Deferred.make<string>()

  const secretFor = (threadId: string) => {
    let secret = secrets.get(threadId)
    if (secret === undefined) {
      secret = Buffer.from(randomBytes(32).toString("base64url"))
      secrets.set(threadId, secret)
    }
    return secret
  }

  return McpCredentials.of({
    connectionFor: (threadId) =>
      Effect.map(Deferred.await(url), (listening) => ({
        url: listening,
        headers: { authorization: `${BEARER}${threadId}.${secretFor(threadId).toString()}` },
      })),
    authenticate: (authorization) => {
      if (authorization === undefined || !authorization.startsWith(BEARER)) return Option.none()
      const credential = authorization.slice(BEARER.length)
      const separator = credential.lastIndexOf(".")
      if (separator <= 0) return Option.none()
      const threadId = credential.slice(0, separator)
      const expected = secrets.get(threadId)
      const presented = Buffer.from(credential.slice(separator + 1))
      const valid =
        expected !== undefined && presented.length === expected.length && timingSafeEqual(presented, expected)
      return valid ? Option.some(threadId) : Option.none()
    },
    listening: (listeningUrl) => Effect.asVoid(Deferred.succeed(url, listeningUrl)),
  })
})

export const layer = Layer.effect(McpCredentials, make)
