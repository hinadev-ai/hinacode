import { describe, expect, it } from "vitest"
import type { RelayMachine } from "./relayMachines.ts"
import { planRelaySync, type SyncedEntry } from "./relaySync.ts"

const machine = (environmentId: string, hosts: [string, ...string[]] = ["192.168.1.20"]): RelayMachine => ({
  environmentId,
  name: environmentId,
  pairing: { hosts, port: 48081, token: `token-${environmentId}`, relay: `${environmentId}.hinacode.app` },
})

const entry = (environmentId: string | null, source: SyncedEntry["source"]) => ({ environmentId, source })

describe("planRelaySync", () => {
  it("adds every listed machine but this one", () => {
    const { upsert } = planRelaySync(
      [],
      [machine("home-server"), machine("this-desktop"), machine("agent-vm")],
      "this-desktop",
    )
    expect(upsert.map(({ environmentId }) => environmentId)).toStrictEqual(["home-server", "agent-vm"])
  })

  it("skips a machine whose pairing no socket can use", () => {
    const { upsert } = planRelaySync([], [machine("broken", ["has space"]), machine("home-server")], null)
    expect(upsert.map(({ environmentId }) => environmentId)).toStrictEqual(["home-server"])
  })

  it("drops a relay entry the list no longer has, and never a paired one", () => {
    const hidden = entry("agent-vm", "relay")
    const paired = entry("laptop", "pairing")
    const kept = entry("home-server", "relay")
    const { drop } = planRelaySync([hidden, paired, kept], [machine("home-server")], null)
    expect(drop).toStrictEqual([hidden])
  })

  it("drops a relay entry for a machine whose pairing became unusable", () => {
    const stale = entry("broken", "relay")
    expect(planRelaySync([stale], [machine("broken", ["has space"])], null).drop).toStrictEqual([stale])
  })
})
