import { Schema } from "effect"
import { pairingUrl, parsePairingUrl } from "./remote.ts"

/** A machine the owner linked to the relay and shows on their devices, with the pairing a QR code would carry. */
export const RelayMachine = Schema.Struct({
  environmentId: Schema.String,
  name: Schema.String,
  pairing: Schema.Struct({
    hosts: Schema.NonEmptyArray(Schema.String),
    port: Schema.Int,
    token: Schema.String,
    relay: Schema.String,
  }),
})
export type RelayMachine = typeof RelayMachine.Type

/** The answer to the relay service's `GET /v1/machines`. */
export const RelayMachineList = Schema.Struct({ machines: Schema.Array(RelayMachine) })

/** Where a client's entry for a machine came from. A relay sync adds, refreshes and drops `relay` entries only. */
export const EntrySource = Schema.Literals(["pairing", "relay"])
export type EntrySource = typeof EntrySource.Type

export interface SyncedEntry {
  readonly environmentId: string | null
  readonly source: EntrySource
}

/**
 * What a client does with the relay's list. Every listed machine but this one, with a pairing a socket can use,
 * is added or refreshed. An entry the relay added before is dropped once the list no longer has it, because the
 * owner hid or unlinked it. An entry paired by QR code is never dropped.
 */
export const planRelaySync = <E extends SyncedEntry>(
  entries: ReadonlyArray<E>,
  machines: ReadonlyArray<RelayMachine>,
  selfId: string | null,
) => {
  const upsert = machines.filter(
    (machine) => machine.environmentId !== selfId && parsePairingUrl(pairingUrl(machine.pairing)) !== null,
  )
  const listed = new Set(upsert.map((machine) => machine.environmentId))
  const drop = entries.filter(
    (entry) => entry.source === "relay" && (entry.environmentId === null || !listed.has(entry.environmentId)),
  )
  return { upsert, drop }
}
