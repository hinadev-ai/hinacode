import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { AutomationRun } from "../../../shared/domain.ts"

export const hookPath = (automationId: string) => `/hooks/${automationId}`

const SIGNATURE_HEADERS = ["x-hinacode-signature", "x-hub-signature-256"]

/** Checks a `sha256=<hex>` HMAC of the raw body, the format GitHub uses for X-Hub-Signature-256. */
export const signatureMatches = (secret: string, body: Uint8Array, header: string | undefined) => {
  const hex = header?.startsWith("sha256=") ? header.slice("sha256=".length) : undefined
  if (hex === undefined || !/^[0-9a-f]{64}$/i.test(hex)) return false
  const expected = createHmac("sha256", secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(hex, "hex"))
}

const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export interface WebhookTarget {
  readonly secret: string
  readonly enabled: boolean
}

export interface WebhookHandlers {
  /** Undefined when no webhook automation has this id. */
  readonly target: (automationId: string) => Effect.Effect<WebhookTarget | undefined>
  readonly deliver: (automationId: string, eventKey: string, payload: unknown) => Effect.Effect<AutomationRun>
}

const json = (body: unknown, status: number) => HttpServerResponse.jsonUnsafe(body, { status })

const handleHook = (handlers: WebhookHandlers) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { id } = yield* HttpRouter.params
    const target = id === undefined ? undefined : yield* handlers.target(id)
    if (id === undefined || target === undefined) return json({ error: "unknown_automation" }, 404)

    const raw = new Uint8Array(yield* request.arrayBuffer)
    const signature = SIGNATURE_HEADERS.map((name) => request.headers[name]).find((value) => value !== undefined)
    if (!signatureMatches(target.secret, raw, signature)) return json({ error: "invalid_signature" }, 401)
    if (!target.enabled) return json({ error: "automation_disabled" }, 409)

    const eventKey = request.headers["x-github-delivery"] ?? createHash("sha256").update(raw).digest("hex")
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !SIGNATURE_HEADERS.includes(name)),
    )
    const body = parseBody(new TextDecoder().decode(raw))
    const run = yield* handlers.deliver(id, eventKey, { body, headers })
    switch (run.status) {
      case "started":
        return json({ runId: run.id, threadId: run.threadId }, 202)
      case "skipped":
        return json({ runId: run.id, threadId: null, skipped: true }, 200)
      case "failed":
        return json({ runId: run.id, error: run.error }, 500)
    }
  }).pipe(Effect.catchTag("HttpServerError", () => Effect.succeed(json({ error: "unreadable_body" }, 400))))

/**
 * The webhook HTTP server, separate from the MCP server so its address can be fixed and exposed
 * beyond loopback. Fails to build when the port is taken.
 */
export const webhookServer = (address: { readonly host: string; readonly port: number }, handlers: WebhookHandlers) =>
  HttpRouter.serve(HttpRouter.add("POST", "/hooks/:id", handleHook(handlers)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provide(NodeHttpServer.layer(createServer, address)))
