import { Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import { type HinacodeBridge, mutations, PushEvent } from "../../../src/shared/contract.ts"
import type { EnvironmentStatus } from "../../../src/shared/domain.ts"
import type { RelayMachine } from "../../../src/shared/relayMachines.ts"
import { type Dial, dialPlan, relayWebSocketUrl } from "../../../src/shared/remote.ts"
import { RpcError, Transport, type TransportMessages } from "../../../src/shared/transport.ts"
import type { RelayAccount } from "./account.ts"
import { makeBrowserAnswers } from "./browser.ts"
import { type MachineLink, makeRoute } from "./route.ts"

const encodePush = Schema.encodeSync(PushEvent)

export const dialsFor = (pairing: RelayMachine["pairing"], secure: boolean): NonEmptyReadonlyArray<Dial> =>
  secure ? [{ url: relayWebSocketUrl(pairing.relay), route: "relay", delayMs: 0 }] : dialPlan(pairing)

export const connectMachines = ({
  account,
  machines,
  messages,
  signOut,
}: {
  readonly account: RelayAccount
  readonly machines: ReadonlyArray<RelayMachine>
  readonly messages: TransportMessages
  readonly signOut: () => void
}): HinacodeBridge => {
  const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()
  const emit = (event: typeof PushEvent.Encoded) => {
    for (const listener of listeners) listener(event)
  }
  const statuses = new Map<string, EnvironmentStatus>()
  const waitingToConnect = new Map<string, Array<() => void>>()
  const connected = (id: string) =>
    statuses.get(id) === "connected"
      ? Promise.resolve()
      : new Promise<void>((resolve) => waitingToConnect.set(id, [...(waitingToConnect.get(id) ?? []), resolve]))
  const secure = location.protocol === "https:"

  const connect = (machine: RelayMachine) => {
    const id = machine.environmentId
    statuses.set(id, "connecting")
    const transport = new Transport({
      dials: dialsFor(machine.pairing, secure),
      token: machine.pairing.token,
      messages,
      compact: false,
      isMutation: (method) => mutations.has(method),
      onStatus: (status) => {
        statuses.set(id, status)
        emit({ type: "environment.status", id, status })
        if (status !== "connected") return
        for (const resume of waitingToConnect.get(id) ?? []) resume()
        waitingToConnect.delete(id)
      },
      onReady: () => {},
      onEvent: (event) => emit(encodePush(route.push(id, event))),
    })
    const link: MachineLink = {
      id,
      name: machine.name,
      status: () => statuses.get(id) ?? "offline",
      connected: () => connected(id),
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
      reconnect: (id) => connections.get(id)?.transport.reconnectNow(),
      emit,
      signOut,
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
