import { Schema } from "effect"

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

export const RelayMachineList = Schema.Struct({ machines: Schema.Array(RelayMachine) })

export const EntrySource = Schema.Literals(["pairing", "relay"])
export type EntrySource = typeof EntrySource.Type

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

export const RelayHostList = Schema.Struct({ hosts: Schema.Array(RelayHost) })

export const PendingLink = Schema.Struct({ name: Schema.String, environmentId: Schema.String })
export type PendingLink = typeof PendingLink.Type
