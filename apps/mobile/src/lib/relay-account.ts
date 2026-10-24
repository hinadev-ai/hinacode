import { Option, Schema } from "effect"
import { planRelaySync, type RelayMachine, RelayMachineList } from "@shared/relayMachines.ts"
import { copy } from "@/lib/copy"
import type { StoredServer } from "./stored-target"

export const RELAY_ACCOUNT_KEY = "hinacode.relayAccount"
export const DEFAULT_RELAY_URL = "https://relay.hinacode.app"

/** The relay this phone signed in to. The owner token lists every machine the owner shows on their devices. */
export interface RelayAccount {
  readonly serviceUrl: string
  readonly ownerToken: string
}

const decodeAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ serviceUrl: Schema.String, ownerToken: Schema.String })),
)

export const parseRelayAccount = (raw: string | null): RelayAccount | null =>
  raw === null ? null : Option.getOrNull(decodeAccount(raw))

export type RelayMachinesResult =
  | { readonly _tag: "machines"; readonly machines: readonly RelayMachine[] }
  | { readonly _tag: "unauthorized" }
  | { readonly _tag: "failed"; readonly message: string }

const decodeList = Schema.decodeUnknownOption(RelayMachineList)

/** Asks the relay for the machines its owner shows on their devices. A 401 means the owner token was rotated. */
export async function fetchRelayMachines(
  account: RelayAccount,
  fetch: typeof globalThis.fetch,
): Promise<RelayMachinesResult> {
  const url = `${account.serviceUrl.replace(/\/+$/, "")}/v1/machines`
  let response: Response
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${account.ownerToken}` } })
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
  let next = servers.filter((server) => !drop.includes(server))
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
