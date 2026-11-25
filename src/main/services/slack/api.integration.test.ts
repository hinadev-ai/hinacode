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

const slackAnswering = (answer: Answer | ((params: URLSearchParams) => Answer)) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          const { status, headers, body } =
            typeof answer === "function" ? answer(new URLSearchParams(Buffer.concat(chunks).toString())) : answer
          response.writeHead(status, { "content-type": "application/json", ...headers })
          response.end(body)
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

  it.live("reads a thread page by page", () =>
    Effect.gen(function* () {
      const api = yield* slackAnswering((params) => ({
        status: 200,
        body: JSON.stringify(
          params.get("cursor") === null
            ? { ok: true, messages: [{ ts: "1.0" }, { ts: "2.0" }], response_metadata: { next_cursor: "more" } }
            : { ok: true, messages: [{ ts: "3.0" }], response_metadata: { next_cursor: "" } },
        ),
      }))
      const messages = yield* api.replies("xoxb-bot", { channel: "C1", ts: "1.0" })
      expect(messages.map((message) => message.ts)).toEqual(["1.0", "2.0", "3.0"])
    }),
  )

  it.live("refuses a thread it cannot read to its end", () =>
    Effect.gen(function* () {
      let pages = 0
      const api = yield* slackAnswering(() => {
        pages += 1
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            messages: [{ ts: `${pages}.0` }],
            response_metadata: { next_cursor: "more" },
          }),
        }
      })
      const error = yield* Effect.flip(api.replies("xoxb-bot", { channel: "C1", ts: "1.0" }))
      expect(error.reason).toBe("the thread has more than 1000 messages")
      expect(error.recoverable).toBe(false)
      expect(pages).toBe(5)
    }),
  )

  it.live("treats an answer in another shape as final", () =>
    Effect.gen(function* () {
      const refusal = yield* refusalFrom({ status: 200, body: JSON.stringify({ ok: true, team: "Acme" }) })
      expect(refusal).toEqual({ reason: "unexpected response", recoverable: false, retryAfterMs: null })
    }),
  )
})
