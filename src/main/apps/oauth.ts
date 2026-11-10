import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"

export const SCOPE = "hinacode"
export const MCP_PATH = "/mcp"
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource"
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server"
export const REGISTER_PATH = "/oauth/register"
export const AUTHORIZE_PATH = "/oauth/authorize"
export const TOKEN_PATH = "/oauth/token"

const MAX_NAME_LENGTH = 100
const MAX_REDIRECT_URIS = 5
const MAX_REDIRECT_URI_LENGTH = 512
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

const parseUrl = (value: string) => (URL.canParse(value) ? new URL(value) : null)

const isLoopback = (url: URL) => url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)

export const isRedirectUri = (value: string) => {
  const url = parseUrl(value)
  return url !== null && url.hash === "" && (url.protocol === "https:" || isLoopback(url))
}

const withoutPort = (url: URL) => {
  const copy = new URL(url)
  copy.port = ""
  return copy.href
}

export const redirectAllowed = (registered: ReadonlyArray<string>, requested: string) => {
  if (registered.includes(requested)) return true
  const url = parseUrl(requested)
  if (url === null || !isLoopback(url)) return false
  return registered.some((candidate) => {
    const known = parseUrl(candidate)
    return known !== null && isLoopback(known) && withoutPort(known) === withoutPort(url)
  })
}

export const Client = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH)),
  redirectUris: Schema.NonEmptyArray(
    Schema.String.check(Schema.isMaxLength(MAX_REDIRECT_URI_LENGTH), Schema.makeFilter(isRedirectUri)),
  ).check(Schema.isMaxLength(MAX_REDIRECT_URIS)),
})
export type Client = typeof Client.Type

const ClientJson = Schema.fromJsonString(Client)
const encodeClient = Schema.encodeSync(ClientJson)
const decodeClient = Schema.decodeUnknownOption(ClientJson)

const sign = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest()

export const signClient = (key: Buffer, client: Client) => {
  const payload = Buffer.from(encodeClient(client)).toString("base64url")
  return `${payload}.${sign(key, payload).toString("base64url")}`
}

export const readClient = (key: Buffer, clientId: string): Option.Option<Client> => {
  const [payload, signature, ...rest] = clientId.split(".")
  if (payload === undefined || signature === undefined || rest.length > 0) return Option.none()
  const expected = sign(key, payload)
  const given = Buffer.from(signature, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return Option.none()
  return decodeClient(Buffer.from(payload, "base64url").toString())
}

export const Registration = Schema.Struct({
  client_name: Schema.optionalKey(Schema.String),
  redirect_uris: Schema.Array(Schema.String),
})

export const clientOf = (registration: typeof Registration.Type): Option.Option<Client> =>
  Schema.decodeUnknownOption(Client)({
    name: registration.client_name?.trim() || parseUrl(registration.redirect_uris[0] ?? "")?.host,
    redirectUris: registration.redirect_uris,
  })

const CodeChallenge = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))
const CodeVerifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/))

export const verifierMatches = (verifier: string, challenge: string) => {
  const expected = Buffer.from(challenge)
  const given = Buffer.from(createHash("sha256").update(verifier).digest("base64url"))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export const AuthorizationParams = Schema.Struct({
  response_type: Schema.optionalKey(Schema.String),
  client_id: Schema.String,
  redirect_uri: Schema.String,
  code_challenge: Schema.optionalKey(Schema.String),
  code_challenge_method: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.String),
})
export type AuthorizationParams = typeof AuthorizationParams.Type

export const ApprovalForm = Schema.Struct({
  ...AuthorizationParams.fields,
  decision: Schema.Literals(["approve", "deny"]),
  approval_code: Schema.optionalKey(Schema.String),
})

export const TokenRequest = Schema.Struct({
  grant_type: Schema.String,
  code: Schema.String,
  redirect_uri: Schema.String,
  client_id: Schema.String,
  code_verifier: CodeVerifier,
  resource: Schema.optionalKey(Schema.String),
})

export type OAuthError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "access_denied"

export const resourceOf = (issuer: string) => `${issuer}${MCP_PATH}`

export type AuthorizationCheck =
  | { readonly ok: true; readonly client: Client; readonly codeChallenge: string }
  | { readonly ok: false; readonly redirect: false }
  | { readonly ok: false; readonly redirect: true; readonly error: OAuthError; readonly description: string }

const refuse = (error: OAuthError, description: string) => ({ ok: false, redirect: true, error, description }) as const

export const checkAuthorization = (key: Buffer, issuer: string, params: AuthorizationParams): AuthorizationCheck => {
  const client = readClient(key, params.client_id)
  if (Option.isNone(client) || !redirectAllowed(client.value.redirectUris, params.redirect_uri)) {
    return { ok: false, redirect: false }
  }
  if (params.response_type !== "code") {
    return refuse("unsupported_response_type", "response_type must be code")
  }
  if (params.code_challenge_method !== "S256" || !Schema.is(CodeChallenge)(params.code_challenge)) {
    return refuse("invalid_request", "PKCE with an S256 code_challenge is required")
  }
  if (params.resource !== undefined && params.resource !== resourceOf(issuer)) {
    return refuse("invalid_target", `resource must be ${resourceOf(issuer)}`)
  }
  return { ok: true, client: client.value, codeChallenge: params.code_challenge }
}

export const redirectTo = (redirectUri: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirectUri)
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value)
  return url.href
}

export const protectedResourceMetadata = (issuer: string) => ({
  resource: resourceOf(issuer),
  authorization_servers: [issuer],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "HinaCode",
})

export const authorizationServerMetadata = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
  token_endpoint: `${issuer}${TOKEN_PATH}`,
  registration_endpoint: `${issuer}${REGISTER_PATH}`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [SCOPE],
})

export const registrationResponse = (clientId: string, client: Client) => ({
  client_id: clientId,
  client_name: client.name,
  redirect_uris: client.redirectUris,
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
})
