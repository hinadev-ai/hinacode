import { Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import { m } from "@/paraglide/messages.js"
import { type HinacodeBridge, mutations, PushEvent } from "../../../src/shared/contract.ts"
import type { EnvironmentStatus, HostApproval, HostRefusal } from "../../../src/shared/domain.ts"
import type { RelayMachine } from "../../../src/shared/relayMachines.ts"
import { type Dial, dialPlan, relayWebSocketUrl } from "../../../src/shared/remote.ts"
import { RpcError, Transport, type TransportMessages } from "../../../src/shared/transport.ts"
import type { RelayAccount } from "./account.ts"
import { makeBrowserAnswers } from "./browser.ts"
import { deviceKey, pinKey, pinnedKey, unpinKey } from "./keys.ts"
import { type MachineLink, makeRoute, waitsForDeveloper } from "./route.ts"

const encodePush = Schema.encodeSync(PushEvent)

const dialsFor = (pairing: RelayMachine["pairing"], secure: boolean): NonEmptyReadonlyArray<Dial> =>
  secure ? [{ url: relayWebSocketUrl(pairing.relay), route: "relay", delayMs: 0 }] : dialPlan(pairing)

const isSettled = (status: EnvironmentStatus) => status === "connected" || waitsForDeveloper(status)

export const connectMachines = ({
  account,
  machines,
  messages,
  signedOut,
}: {
  readonly account: RelayAccount
  readonly machines: ReadonlyArray<RelayMachine>
  readonly messages: (machine: string) => TransportMessages
  readonly signedOut: () => void
}): HinacodeBridge => {
  const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()
  const emit = (event: typeof PushEvent.Encoded) => {
    for (const listener of listeners) listener(event)
  }
  const statuses = new Map<string, EnvironmentStatus>()
  const refusals = new Map<string, HostRefusal>()
  const approvals = new Map<string, HostApproval>()
  const device = deviceKey()
  const waitingToSettle = new Map<string, Array<() => void>>()
  const settled = (id: string) =>
    isSettled(statuses.get(id) ?? "offline")
      ? Promise.resolve()
      : new Promise<void>((resolve) => waitingToSettle.set(id, [...(waitingToSettle.get(id) ?? []), resolve]))
  const secure = location.protocol === "https:"

  const connect = (machine: RelayMachine) => {
    const id = machine.environmentId
    const pinned = pinnedKey(id)
    const hostKey = pinned ?? machine.pairing.key
    statuses.set(id, "connecting")
    const changed = () => emit({ type: "environment.status", id, status: statuses.get(id) ?? "offline" })
    const transport = new Transport({
      dials: dialsFor(machine.pairing, secure),
      hostKey,
      device,
      name: m.web_device_name(),
      secret: null,
      verified: pinned !== null,
      messages: messages(machine.name),
      compact: false,
      isMutation: (method) => mutations.has(method),
      onStatus: (status, _, refusal) => {
        statuses.set(id, status)
        if (refusal === null) refusals.delete(id)
        else refusals.set(id, refusal)
        changed()
        if (!isSettled(status)) return
        for (const resume of waitingToSettle.get(id) ?? []) resume()
        waitingToSettle.delete(id)
      },
      onReady: () => {},
      onEvent: (event) => emit(encodePush(route.push(id, event))),
      onSecretUsed: () => {},
      onApproval: (approval) => {
        if (approval === null) approvals.delete(id)
        else approvals.set(id, approval)
        changed()
      },
      onVerified: () => pinKey(id, hostKey),
    })
    const link: MachineLink = {
      id,
      name: machine.name,
      status: () => statuses.get(id) ?? "offline",
      settled: () => settled(id),
      call: (method, payload) =>
        transport.call(method, payload).catch((error: Error) => ({
          error: { tag: error instanceof RpcError ? error.tag : "Offline", message: error.message },
        })),
    }
    return { link, transport }
  }

  const connections = new Map(machines.map((machine) => [machine.environmentId, connect(machine)]))

  const route = makeRoute({
    machines: new Map([...connections].map(([id, connection]) => [id, connection.link])),
    browser: makeBrowserAnswers({
      account,
      machines,
      statusOf: (id) => statuses.get(id) ?? "offline",
      approvalOf: (id) => approvals.get(id),
      refusalOf: (id) => refusals.get(id),
      reconnect: (id) => connections.get(id)?.transport.reconnectNow(),
      confirmHost: (id, accepted) => connections.get(id)?.transport.confirmHost(accepted),
      repair: (id) => {
        unpinKey(id)
        location.reload()
      },
      emit,
      signedOut,
    }),
  })

  window.addEventListener("online", () => {
    for (const { transport } of connections.values()) transport.networkChanged()
  })
  for (const { transport } of connections.values()) transport.start()

  return {
    rpc: (method, payload, environment) => route.call(method, payload, environment) as never,
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pathForFile: () => "",
    liquidGlass: false,
    runtime: { kind: "web" },
  }
}
