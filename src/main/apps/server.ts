import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { ByteSize, Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer as AiMcpServer } from "effect/ai"
import { HttpIncomingMessage, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Secrets } from "../services/Secrets.ts"
import { AppConnections } from "./AppConnections.ts"
import { brokenLinkPage, notStartedPage, waitingPage } from "./approvalPage.ts"
import {
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  AuthorizationParams,
  authorizationServerMetadata,
  checkAuthorization,
  clientOf,
  isRedirectUri,
  MCP_PATH,
  type OAuthError,
  PROTECTED_RESOURCE_PATH,
  protectedResourceMetadata,
  readClient,
  redirectTo,
  REGISTER_PATH,
  Registration,
  registrationResponse,
  resourceOf,
  SCOPE,
  signClient,
  TOKEN_PATH,
  TokenRequest,
  verifierMatches,
  WAIT_PATH,
  WaitParams,
} from "./oauth.ts"
import * as Tools from "./tools.ts"

const CLIENT_KEY_SECRET = "apps.clientKey"
const MAX_OAUTH_BODY = ByteSize.kilobytes(64)
const MAX_MCP_BYTES = 1024 * 1024
const PUBLIC_PATHS = new Set([
  PROTECTED_RESOURCE_PATH,
  `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`,
  AUTHORIZATION_SERVER_PATH,
  REGISTER_PATH,
  AUTHORIZE_PATH,
  WAIT_PATH,
  TOKEN_PATH,
])

const NO_STORE = { "cache-control": "no-store" }
const notFound = HttpServerResponse.empty({ status: 404 })

const oauthError = (error: OAuthError, description: string) =>
  HttpServerResponse.jsonUnsafe({ error, error_description: description }, { status: 400, headers: NO_STORE })

const page = ({ html, headers }: ReturnType<typeof brokenLinkPage>, status = 200) =>
  HttpServerResponse.html(html).pipe(HttpServerResponse.setStatus(status), HttpServerResponse.setHeaders(headers))

const clientKey = Effect.gen(function* () {
  const secrets = yield* Secrets
  const stored = yield* secrets.get(CLIENT_KEY_SECRET)
  if (Option.isSome(stored)) return Buffer.from(stored.value, "base64url")
  const key = randomBytes(32)
  yield* secrets.set(CLIENT_KEY_SECRET, key.toString("base64url"))
  return key
})

const gate = HttpRouter.middleware(
  Effect.gen(function* () {
    const connections = yield* AppConnections
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const issuer = yield* connections.issuer
        if (Option.isNone(issuer) || !(yield* connections.inUse)) return notFound
        const path = request.url.split("?", 1)[0]!
        if (PUBLIC_PATHS.has(path)) {
          return yield* Effect.provideService(httpEffect, HttpIncomingMessage.MaxBodySize, MAX_OAUTH_BODY)
        }
        if (path !== MCP_PATH) return notFound
        const app = yield* connections.authenticate(request.headers["authorization"])
        if (Option.isSome(app)) {
          if (request.method === "POST" && !(Number(request.headers["content-length"]) <= MAX_MCP_BYTES)) {
            return HttpServerResponse.empty({ status: 413 })
          }
          return yield* Effect.provideService(httpEffect, Tools.CallingApp, app.value)
        }
        return HttpServerResponse.jsonUnsafe(
          { error: "invalid_token" },
          {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${issuer.value}${PROTECTED_RESOURCE_PATH}"` },
          },
        )
      }).pipe(Effect.catchTag("PersistenceError", () => Effect.succeed(HttpServerResponse.empty({ status: 500 }))))
  }),
  { global: true },
)

const routes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const connections = yield* AppConnections
    const key = yield* clientKey

    const withIssuer = <R>(
      respond: (issuer: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
    ) => Effect.flatMap(connections.issuer, Option.match({ onNone: () => Effect.succeed(notFound), onSome: respond }))

    const resourceMetadata = withIssuer((issuer) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe(protectedResourceMetadata(issuer))),
    )
    yield* router.add("GET", PROTECTED_RESOURCE_PATH, resourceMetadata)
    yield* router.add("GET", `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`, resourceMetadata)
    yield* router.add(
      "GET",
      AUTHORIZATION_SERVER_PATH,
      withIssuer((issuer) => Effect.succeed(HttpServerResponse.jsonUnsafe(authorizationServerMetadata(issuer)))),
    )

    yield* router.add(
      "POST",
      REGISTER_PATH,
      HttpServerRequest.schemaBodyJson(Registration).pipe(
        Effect.map((registration) => {
          if (registration.redirect_uris.length === 0 || !registration.redirect_uris.every(isRedirectUri)) {
            return oauthError("invalid_redirect_uri", "redirect_uris must be https, or http on loopback")
          }
          return Option.match(clientOf(registration), {
            onNone: () => oauthError("invalid_client_metadata", "client_name or redirect_uris is too long"),
            onSome: (client) =>
              HttpServerResponse.jsonUnsafe(registrationResponse(signClient(key, client), client), {
                status: 201,
                headers: NO_STORE,
              }),
          })
        }),
        Effect.catch(() => Effect.succeed(oauthError("invalid_client_metadata", "The body must be JSON metadata"))),
      ),
    )

    const authorization = (issuer: string, params: AuthorizationParams) => {
      const check = checkAuthorization(key, issuer, params)
      if (check.ok) return { ok: true, client: check.client, codeChallenge: check.codeChallenge } as const
      return {
        ok: false,
        response: check.redirect
          ? HttpServerResponse.redirect(
              redirectTo(params.redirect_uri, {
                error: check.error,
                error_description: check.description,
                state: params.state,
              }),
              { headers: NO_STORE },
            )
          : page(brokenLinkPage(), 400),
      } as const
    }

    yield* router.add(
      "GET",
      AUTHORIZE_PATH,
      withIssuer((issuer) =>
        HttpServerRequest.schemaSearchParams(AuthorizationParams).pipe(
          Effect.flatMap((params) =>
            Effect.gen(function* () {
              const checked = authorization(issuer, params)
              if (!checked.ok) return checked.response
              const id = yield* connections.request({
                clientId: params.client_id,
                name: checked.client.name,
                redirectUri: params.redirect_uri,
                codeChallenge: checked.codeChallenge,
                state: params.state,
              })
              return Option.match(id, {
                onNone: () => page(notStartedPage(), 409),
                onSome: (request) =>
                  HttpServerResponse.redirect(`${WAIT_PATH}?${new URLSearchParams({ request })}`, {
                    status: 303,
                    headers: NO_STORE,
                  }),
              })
            }),
          ),
          Effect.catch(() => Effect.succeed(page(brokenLinkPage(), 400))),
        ),
      ),
    )

    yield* router.add(
      "GET",
      WAIT_PATH,
      HttpServerRequest.schemaSearchParams(WaitParams).pipe(
        Effect.flatMap(({ request }) => connections.outcome(request)),
        Effect.map((outcome) => {
          if (outcome.type === "unknown") return page(brokenLinkPage(), 404)
          const { name, redirectUri, state } = outcome.request
          if (outcome.type === "waiting") {
            return page(waitingPage({ appName: name, redirectHost: new URL(redirectUri).host }))
          }
          const answer =
            outcome.type === "approved"
              ? { code: outcome.authorizationCode }
              : { error: "access_denied", error_description: "The developer denied the connection" }
          return HttpServerResponse.redirect(redirectTo(redirectUri, { ...answer, state }), { headers: NO_STORE })
        }),
        Effect.catch(() => Effect.succeed(page(brokenLinkPage(), 400))),
      ),
    )

    yield* router.add(
      "POST",
      TOKEN_PATH,
      withIssuer((issuer) =>
        HttpServerRequest.schemaBodyUrlParams(TokenRequest).pipe(
          Effect.catch(() =>
            Effect.fail(oauthError("invalid_request", "code, redirect_uri, client_id and code_verifier are required")),
          ),
          Effect.flatMap((request) =>
            Effect.gen(function* () {
              if (request.grant_type !== "authorization_code") {
                return oauthError("unsupported_grant_type", "grant_type must be authorization_code")
              }
              if (Option.isNone(readClient(key, request.client_id))) {
                return oauthError("invalid_client", "client_id is not one this server registered")
              }
              if (request.resource !== undefined && request.resource !== resourceOf(issuer)) {
                return oauthError("invalid_target", `resource must be ${resourceOf(issuer)}`)
              }
              const grant = yield* connections.redeem(request.code)
              if (
                Option.isNone(grant) ||
                grant.value.clientId !== request.client_id ||
                grant.value.redirectUri !== request.redirect_uri ||
                !verifierMatches(request.code_verifier, grant.value.codeChallenge)
              ) {
                return oauthError("invalid_grant", "The authorization code is not valid for this request")
              }
              const { token } = yield* connections.connect(grant.value.name)
              return HttpServerResponse.jsonUnsafe(
                { access_token: token, token_type: "Bearer", scope: SCOPE },
                { headers: NO_STORE },
              )
            }),
          ),
          Effect.catchTag("PersistenceError", () => Effect.succeed(HttpServerResponse.empty({ status: 500 }))),
          Effect.catch((response) => Effect.succeed(response)),
        ),
      ),
    )
  }),
)

const httpServer = HttpRouter.serve(
  Layer.mergeAll(Tools.layer, routes, gate).pipe(
    Layer.provideMerge(
      AiMcpServer.layerHttp({
        name: "hinacode",
        version: "0.1.0",
        path: MCP_PATH,
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
        allowSessionTermination: true,
      }),
    ),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })))

const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    if (address._tag === "UnixPathAddress") return yield* Effect.die("app server must listen on TCP")
    yield* Effect.logInfo("app server listening", address.port)
    yield* (yield* AppConnections).listening(address.port)
  }),
)

export const layer = announce.pipe(Layer.provide(httpServer))
