import { Option, Schema } from "effect"
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

const decodeSignIn = Schema.decodeUnknownOption(
  Schema.Struct({
    deviceCode: Schema.String,
    url: Schema.String,
    interval: Schema.Number,
    expiresAt: Schema.Number,
  }),
)

export interface RelaySignIn {
  readonly deviceCode: string
  readonly url: string
  readonly interval: number
  readonly expiresAt: number
}

export type RelaySignInStart =
  | { readonly _tag: "started"; readonly signIn: RelaySignIn }
  | { readonly _tag: "failed"; readonly message: string }

/** Asks the relay for a page where the signed-in person approves this phone. */
export async function startRelaySignIn(
  serviceUrl: string,
  name: string,
  fetch: typeof globalThis.fetch,
): Promise<RelaySignInStart> {
  let response: Response
  try {
    response = await fetch(endpoint(serviceUrl, "/v1/sign-ins"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  } catch {
    return { _tag: "failed", message: copy("mobile_relay_unreachable") }
  }
  if (!response.ok) return { _tag: "failed", message: copy("mobile_relay_bad_status", { status: String(response.status) }) }
  const signIn = Option.getOrNull(decodeSignIn(await response.json().catch(() => null)))
  if (signIn === null) return { _tag: "failed", message: copy("mobile_relay_bad_answer") }
  return { _tag: "started", signIn }
}

const decodeClaimed = Schema.decodeUnknownOption(Schema.Struct({ credential: Schema.String }))

export type RelaySignInClaim =
  | { readonly _tag: "pending" }
  | { readonly _tag: "expired" }
  | { readonly _tag: "claimed"; readonly credential: string }

/** Asks whether the sign-in was approved. A network failure counts as pending, so the next poll tries again. */
export async function claimRelaySignIn(
  serviceUrl: string,
  deviceCode: string,
  fetch: typeof globalThis.fetch,
): Promise<RelaySignInClaim> {
  let response: Response
  try {
    response = await fetch(endpoint(serviceUrl, "/v1/links/claim"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    })
  } catch {
    return { _tag: "pending" }
  }
  if (response.status === 410) return { _tag: "expired" }
  if (!response.ok || response.status === 202) return { _tag: "pending" }
  const claimed = Option.getOrNull(decodeClaimed(await response.json().catch(() => null)))
  return claimed === null ? { _tag: "pending" } : { _tag: "claimed", credential: claimed.credential }
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
