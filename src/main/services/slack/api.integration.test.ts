import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeSlackApi } from "./api.ts"

interface Answer {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body: string
}

const slackAnswering = (answer: Answer) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((request, response) => {
        request.resume()
        request.on("end", () => {
          response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers })
          response.end(answer.body)
        })
      })
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
    }),
    (server) =>
      Effect.sync(() => {
        server.close()
        server.closeAllConnections()
      }),
  ).pipe(Effect.map((server) => makeSlackApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`)))

const refusalFrom = (answer: Answer) =>
  Effect.gen(function* () {
    const api = yield* slackAnswering(answer)
    const error = yield* Effect.flip(api.authTest("xoxb-bot"))
    return { reason: error.reason, recoverable: error.recoverable, retryAfterMs: error.retryAfterMs }
  })

describe("slack api", () => {
  it.live("carries Retry-After from a rate limit", () =>
    Effect.gen(function* () {
      const refusal = yield* refusalFrom({
        status: 429,
        headers: { "retry-after": "60" },
        body: JSON.stringify({ ok: false, error: "ratelimited" }),
      })
      expect(refusal).toEqual({ reason: "HTTP 429", recoverable: true, retryAfterMs: 60_000 })
    }),
  )

  it.live("treats a server error as passing, whatever its body says", () =>
    Effect.gen(function* () {
      const json = yield* refusalFrom({ status: 503, body: JSON.stringify({ error: "upstream unavailable" }) })
      const html = yield* refusalFrom({ status: 502, body: "<html>Bad gateway</html>" })
      expect(json).toEqual({ reason: "HTTP 503", recoverable: true, retryAfterMs: null })
      expect(html).toEqual({ reason: "HTTP 502", recoverable: true, retryAfterMs: null })
    }),
  )

  it.live("treats a refused token as final", () =>
    Effect.gen(function* () {
      const refusal = yield* refusalFrom({ status: 200, body: JSON.stringify({ ok: false, error: "invalid_auth" }) })
      expect(refusal).toEqual({ reason: "invalid_auth", recoverable: false, retryAfterMs: null })
    }),
  )

  it.live("treats an answer in another shape as final", () =>
    Effect.gen(function* () {
      const refusal = yield* refusalFrom({ status: 200, body: JSON.stringify({ ok: true, team: "Acme" }) })
      expect(refusal).toEqual({ reason: "unexpected response", recoverable: false, retryAfterMs: null })
    }),
  )
})
