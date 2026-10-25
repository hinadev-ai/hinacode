import { Schema } from "effect"

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

/**
 * A machine linked to the relay, as its owner manages it. `enabled` is Show on my devices, and `published` says
 * whether the machine has sent its pairing yet.
 */
export const RelayHost = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.String,
  name: Schema.String,
  hostname: Schema.String,
  createdAt: Schema.Number,
  enabled: Schema.Boolean,
  published: Schema.Boolean,
})
export type RelayHost = typeof RelayHost.Type

/** The answer to the relay service's `GET /v1/hosts`. */
export const RelayHostList = Schema.Struct({ hosts: Schema.Array(RelayHost) })

/** A machine waiting for the owner to approve its link code, as `GET /v1/links/:userCode` answers. */
export const PendingLink = Schema.Struct({ name: Schema.String, environmentId: Schema.String })
export type PendingLink = typeof PendingLink.Type
