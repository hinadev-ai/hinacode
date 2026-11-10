import { createHmac, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { ByteSize, Effect, Layer } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { RoutineRun } from "../../../shared/domain.ts"

export const hookPath = (routineId: string) => `/hooks/routines/${routineId}`

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

export const webhookServer = (address: { readonly host: string; readonly port: number }, handlers: WebhookHandlers) =>
  HttpRouter.serve(HttpRouter.add("POST", "/hooks/routines/:id", handleHook(handlers)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provide(NodeHttpServer.layer(createServer, address)))
