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

export type HomeStatus = { readonly status: EnvironmentStatus; readonly error: string | null }

interface Connection {
  readonly link: MachineLink
  readonly transport: Transport
}

export const connectMachines = ({
  account,
  home,
  others,
  messages,
  onHomeStatus,
  signOut,
}: {
  readonly account: RelayAccount
  readonly home: RelayMachine
  readonly others: ReadonlyArray<RelayMachine>
  readonly messages: TransportMessages
  readonly onHomeStatus: (status: HomeStatus) => void
  readonly signOut: () => void
}): HinacodeBridge => {
  const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()
  const emit = (event: typeof PushEvent.Encoded) => {
    for (const listener of listeners) listener(event)
  }
  const statuses = new Map<string, EnvironmentStatus>()
  const secure = location.protocol === "https:"

  const connect = (machine: RelayMachine, onStatus: (status: EnvironmentStatus, error: string | null) => void) => {
    const id = machine.environmentId
    statuses.set(id, "connecting")
    const transport = new Transport({
      dials: dialsFor(machine.pairing, secure),
      token: machine.pairing.token,
      messages,
      compact: false,
      isMutation: (method) => mutations.has(method),
      onStatus: (status, error) => {
        statuses.set(id, status)
        onStatus(status, error)
      },
      onReady: () => {},
      onEvent: (event) => emit(encodePush(route.push(id, event))),
    })
    const link: MachineLink = {
      id,
      name: machine.name,
      status: () => statuses.get(id) ?? "offline",
      call: (method, payload) =>
        transport.call(method, payload).catch((error: Error) => ({
          error: { tag: error instanceof RpcError ? error.tag : "Offline", message: error.message },
        })),
    }
    return { link, transport }
  }

  const homeConnection = connect(home, (status, error) => onHomeStatus({ status, error }))
  const otherConnections = new Map<string, Connection>(
    others.map((machine) => [
      machine.environmentId,
      connect(machine, (status) => emit({ type: "environment.status", id: machine.environmentId, status })),
    ]),
  )
  const connections = [homeConnection, ...otherConnections.values()]

  const route = makeRoute({
    home: homeConnection.link,
    others: new Map([...otherConnections].map(([id, connection]) => [id, connection.link])),
    browser: makeBrowserAnswers({
      account,
      home,
      others,
      statusOf: (id) => statuses.get(id) ?? "offline",
      reconnect: (id) => otherConnections.get(id)?.transport.reconnectNow(),
      emit,
      signOut,
    }),
  })

  window.addEventListener("online", () => {
    for (const { transport } of connections) transport.networkChanged()
  })
  for (const { transport } of connections) transport.start()

  return {
    rpc: (method, payload, environment) => route.call(method, payload, environment) as never,
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pathForFile: () => "",
    liquidGlass: false,
    runtime: { kind: "web", machine: home.name },
  }
}
