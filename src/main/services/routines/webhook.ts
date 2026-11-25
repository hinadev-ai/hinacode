import { createHmac, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { LinearWebhookClient } from "@linear/sdk/webhooks"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { ByteSize, Effect, Layer, Option, Schema } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { RoutineRun } from "../../../shared/domain.ts"
import { type Arrival, githubArrival, linearArrival } from "./triggers.ts"

export const hookPath = (routineId: string) => `/hooks/routines/${routineId}`

export const GITHUB_HOOK_PATH = "/hooks/github"
export const LINEAR_HOOK_PATH = "/hooks/linear"

const SIGNATURE_HEADERS = ["x-hinacode-signature", "x-hub-signature-256"]
const EVENT_KEY_HEADERS = ["idempotency-key", "x-github-delivery"]

export const signatureMatches = (secret: string, body: Uint8Array, header: string | undefined) => {
  const hex = header?.startsWith("sha256=") ? header.slice("sha256=".length) : undefined
  if (hex === undefined || !/^[0-9a-f]{64}$/i.test(hex)) return false
  const expected = createHmac("sha256", secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(hex, "hex"))
}

export const bearerMatches = (secret: string, header: string | undefined) => {
  const token = header?.startsWith("Bearer ") ? Buffer.from(header.slice("Bearer ".length)) : undefined
  const expected = Buffer.from(secret)
  return token !== undefined && token.length === expected.length && timingSafeEqual(token, expected)
}

export interface WebhookHandlers {
  readonly secret: Effect.Effect<string | undefined>
  readonly enabled: (routineId: string) => Effect.Effect<boolean | undefined>
  readonly deliver: (routineId: string, body: string | null, eventKey: string | null) => Effect.Effect<RoutineRun>
  readonly arrive: (arrival: Arrival) => Effect.Effect<ReadonlyArray<RoutineRun>>
  readonly linear: {
    readonly secret: Effect.Effect<string | undefined>
    readonly viewerId: Effect.Effect<string | null, unknown>
    readonly wroteComment: (id: string) => Effect.Effect<boolean>
  }
}

const MAX_BODY_BYTES = 1024 * 1024

const json = (body: unknown, status: number) => HttpServerResponse.jsonUnsafe(body, { status })

const firstHeader = (headers: Readonly<Record<string, string | undefined>>, names: ReadonlyArray<string>) =>
  names.map((name) => headers[name]).find((value) => value !== undefined && value !== "")

const handleHook = (handlers: WebhookHandlers) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { id } = yield* HttpRouter.params
    const secret = yield* handlers.secret
    if (secret === undefined) return json({ error: "unauthorized" }, 401)
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413)
    const raw = new Uint8Array(yield* request.arrayBuffer)
    const authorized =
      bearerMatches(secret, request.headers["authorization"]) ||
      signatureMatches(secret, raw, firstHeader(request.headers, SIGNATURE_HEADERS))
    if (!authorized) return json({ error: "unauthorized" }, 401)

    const enabled = id === undefined ? undefined : yield* handlers.enabled(id)
    if (id === undefined || enabled === undefined) return json({ error: "unknown_routine" }, 404)
    if (!enabled) return json({ error: "routine_disabled" }, 409)

    const body = new TextDecoder().decode(raw)
    const run = yield* handlers.deliver(
      id,
      body.trim() === "" ? null : body,
      firstHeader(request.headers, EVENT_KEY_HEADERS) ?? null,
    )
    switch (run.status) {
      case "started":
        return json({ runId: run.id, threadId: run.threadId }, 202)
      case "skipped":
        return json({ runId: run.id, threadId: null, skipped: true, reason: run.error }, 200)
      case "failed":
        return json({ runId: run.id, error: run.error }, 500)
    }
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.catchTag("HttpServerError", () => Effect.succeed(json({ error: "unreadable_body" }, 400))),
  )

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const runsBody = (runs: ReadonlyArray<RoutineRun>) => ({
  runs: runs.map((run) => ({ runId: run.id, threadId: run.threadId, status: run.status })),
})

const handleGitHub = (handlers: WebhookHandlers) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const secret = yield* handlers.secret
    if (secret === undefined) return json({ error: "unauthorized" }, 401)
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413)
    const raw = new Uint8Array(yield* request.arrayBuffer)
    if (!signatureMatches(secret, raw, request.headers["x-hub-signature-256"])) {
      return json({ error: "unauthorized" }, 401)
    }
    const payload = parseJson(new TextDecoder().decode(raw))
    if (Option.isNone(payload)) return json({ error: "not_json" }, 400)
    const arrival = githubArrival(request.headers["x-github-event"] ?? "", payload.value)
    const runs = arrival === null ? [] : yield* handlers.arrive(arrival)
    return json(runsBody(runs), 202)
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.catchTag("HttpServerError", () => Effect.succeed(json({ error: "unreadable_body" }, 400))),
  )

const linearVerdict = (secret: string, raw: Uint8Array, signature: string) => {
  try {
    return new LinearWebhookClient(secret).verify(Buffer.from(raw), signature) ? "verified" : "unauthorized"
  } catch (error) {
    return error instanceof SyntaxError ? "not_json" : "unauthorized"
  }
}

const decodeLinearSubject = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, data: Schema.Struct({ id: Schema.String }) }),
)

const handleLinear = ({ linear, arrive }: WebhookHandlers) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const secret = yield* linear.secret
    const signature = request.headers["linear-signature"]
    if (secret === undefined || signature === undefined) return json({ error: "unauthorized" }, 401)
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413)
    const raw = new Uint8Array(yield* request.arrayBuffer)
    const verdict = linearVerdict(secret, raw, signature)
    if (verdict === "not_json") return json({ error: "not_json" }, 400)
    if (verdict === "unauthorized") return json({ error: "unauthorized" }, 401)
    const payload = parseJson(new TextDecoder().decode(raw))
    if (Option.isNone(payload)) return json({ error: "not_json" }, 400)
    const subject = decodeLinearSubject(payload.value)
    if (Option.isNone(subject)) return json(runsBody([]), 200)
    const { type, data } = subject.value
    if (type === "Comment" && (yield* linear.wroteComment(data.id))) return json(runsBody([]), 200)
    const viewerId = type === "Issue" ? yield* Effect.option(linear.viewerId) : Option.some(null)
    if (Option.isNone(viewerId)) return json({ error: "linear_unavailable" }, 503)
    const arrival = linearArrival(payload.value, viewerId.value)
    return json(runsBody(arrival === null ? [] : yield* arrive(arrival)), 200)
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.catchTag("HttpServerError", () => Effect.succeed(json({ error: "unreadable_body" }, 400))),
  )

export const webhookServer = (address: { readonly host: string; readonly port: number }, handlers: WebhookHandlers) =>
  HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add("POST", "/hooks/routines/:id", handleHook(handlers)),
      HttpRouter.add("POST", GITHUB_HOOK_PATH, handleGitHub(handlers)),
      HttpRouter.add("POST", LINEAR_HOOK_PATH, handleLinear(handlers)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provide(NodeHttpServer.layer(createServer, address)))
