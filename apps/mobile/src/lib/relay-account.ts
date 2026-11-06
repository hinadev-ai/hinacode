import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"
import { Option, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { type RelayMachine, RelayMachineList } from "@shared/relayMachines.ts"
import { planRelaySync } from "@shared/relaySync.ts"
import { copy } from "@/lib/copy"
import type { StoredServer } from "./stored-target"

export const RELAY_ACCOUNT_KEY = "hinacode.relayAccount"
export const DEFAULT_RELAY_URL = "https://relay.hinacode.app"

/** The relay this phone signed in to. Its credential lists every machine the account shows on its devices. */
export interface RelayAccount {
  readonly serviceUrl: string
  readonly credential: string
}

const decodeAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ serviceUrl: Schema.String, credential: Schema.String })),
)

export const parseRelayAccount = (raw: string | null): RelayAccount | null =>
  raw === null ? null : Option.getOrNull(decodeAccount(raw))

export type RelayMachinesResult =
  | { readonly _tag: "machines"; readonly machines: readonly RelayMachine[] }
  | { readonly _tag: "unauthorized" }
  | { readonly _tag: "failed"; readonly message: string }

const decodeList = Schema.decodeUnknownOption(RelayMachineList)

/** Asks the relay for the machines the account shows on its devices. A 401 means this phone was signed out. */
export async function fetchRelayMachines(
  account: RelayAccount,
  fetch: typeof globalThis.fetch,
): Promise<RelayMachinesResult> {
  const url = endpoint(account.serviceUrl, "/v1/machines")
  let response: Response
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${account.credential}` } })
  } catch {
    return failed(copy("mobile_relay_unreachable"))
  }
  if (response.status === 401) return { _tag: "unauthorized" }
  if (!response.ok) return failed(copy("mobile_relay_bad_status", { status: String(response.status) }))
  const list = Option.getOrNull(decodeList(await response.json().catch(() => null)))
  if (list === null) return failed(copy("mobile_relay_bad_answer"))
  return { _tag: "machines", machines: list.machines }
}

const failed = (message: string): RelayMachinesResult => ({ _tag: "failed", message })

const endpoint = (serviceUrl: string, path: string) => `${serviceUrl.replace(/\/+$/, "")}${path}`

/** The PKCE pair for one sign-in: the relay stores the challenge and hands out a code only the verifier redeems. */
export const pkcePair = (random: Uint8Array) => {
  const verifier = Base64Url.encode(random)
  return { verifier, challenge: Base64Url.encode(sha256(utf8ToBytes(verifier))) }
}

export const signInUrl = (
  serviceUrl: string,
  { redirectUri, challenge, name }: { redirectUri: string; challenge: string; name: string },
) =>
  `${endpoint(serviceUrl, "/sign-in")}?${new URLSearchParams({ redirect_uri: redirectUri, code_challenge: challenge, name })}`

export const codeFromCallback = (url: string): string | null => {
  const parsed = URL.parse(url)
  if (parsed === null || parsed.protocol !== "hinacode:" || parsed.host !== "signed-in") return null
  return parsed.searchParams.get("code")
}

const decodeExchanged = Schema.decodeUnknownOption(Schema.Struct({ credential: Schema.String }))

export type RelaySignInResult =
  | { readonly _tag: "signedIn"; readonly credential: string }
  | { readonly _tag: "failed"; readonly message: string }

/** Redeems the code from the sign-in redirect for this phone's credential. The relay spends the code either way. */
export async function exchangeSignInCode(
  serviceUrl: string,
  code: string,
  codeVerifier: string,
  fetch: typeof globalThis.fetch,
): Promise<RelaySignInResult> {
  let response: Response
  try {
    response = await fetch(endpoint(serviceUrl, "/v1/sign-in-codes/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    })
  } catch {
    return { _tag: "failed", message: copy("mobile_relay_unreachable") }
  }
  if (response.status === 410) return { _tag: "failed", message: copy("mobile_relay_sign_in_expired") }
  if (!response.ok) return { _tag: "failed", message: copy("mobile_relay_bad_status", { status: String(response.status) }) }
  const exchanged = Option.getOrNull(decodeExchanged(await response.json().catch(() => null)))
  if (exchanged === null) return { _tag: "failed", message: copy("mobile_relay_bad_answer") }
  return { _tag: "signedIn", credential: exchanged.credential }
}

/** Ends this phone's sign-in on the relay. Best effort, because signing out must work offline. */
export const signOutRelayDevice = (account: RelayAccount, fetch: typeof globalThis.fetch) =>
  fetch(endpoint(account.serviceUrl, "/v1/device"), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${account.credential}` },
  }).then(
    () => undefined,
    () => undefined,
  )

/**
 * The stored servers after a sync: each listed machine refreshes the server with its environment id or relay
 * hostname, or is added as a relay server, and relay servers the list lost are dropped. QR-paired servers keep
 * their name and are never dropped.
 */
export function applyRelayMachines(
  servers: readonly StoredServer[],
  machines: readonly RelayMachine[],
  newId: () => string,
): StoredServer[] {
  const { upsert, drop } = planRelaySync(servers, machines, null)
  const dropped = new Set(drop)
  let next = servers.filter((server) => !dropped.has(server))
  for (const machine of upsert) {
    const same =
      next.find((server) => server.environmentId === machine.environmentId) ??
      next.find((server) => server.relay === machine.pairing.relay)
    if (same === undefined) {
      next = [
        ...next,
        { id: newId(), name: machine.name, environmentId: machine.environmentId, ...machine.pairing, source: "relay" },
      ]
      continue
    }
    const refreshed: StoredServer = {
      ...same,
      ...machine.pairing,
      environmentId: machine.environmentId,
      name: same.source === "relay" ? machine.name : same.name,
    }
    next = next.map((server) => (server === same ? refreshed : server))
  }
  return next
}
