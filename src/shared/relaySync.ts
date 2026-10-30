import type { EntrySource, RelayMachine } from "./relayMachines.ts"
import { pairingUrl, parsePairingUrl } from "./remote.ts"

export interface SyncedEntry {
  readonly environmentId: string | null
  readonly source: EntrySource
}

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
