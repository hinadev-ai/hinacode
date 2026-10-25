import type { EntrySource, RelayMachine } from "./relayMachines.ts"
import { pairingUrl, parsePairingUrl } from "./remote.ts"

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
