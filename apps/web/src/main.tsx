import "@/index.css"
import { createRoot } from "react-dom/client"
import { applyAppearance } from "@/lib/appearance.ts"
import { m } from "@/paraglide/messages.js"
import { useLocale } from "@/stores/locale.ts"
import type { RelayMachine } from "../../../src/shared/relayMachines.ts"
import type { TransportMessages } from "../../../src/shared/transport.ts"
import {
  fetchMachines,
  forgetHome,
  type RelayAccount,
  saveHome,
  signOut,
  storedAccount,
  storedHome,
} from "./account.ts"
import { connectMachines } from "./bridge.ts"
import { readSettings } from "./browser.ts"
import { describeFailure, Gate, type GateState } from "./Gate.tsx"
import { HomeStatusBar, makeHomeStatus } from "./HomeStatusBar.tsx"

const transportMessages: TransportMessages = {
  notSent: m.web_transport_not_sent(),
  mayHaveRun: m.web_transport_may_have_run(),
  lostReply: m.web_transport_lost_reply(),
  disconnected: m.web_transport_disconnected(),
  notConnected: m.web_transport_not_connected(),
  tokenRotated: m.web_transport_token_rotated(),
  tokenRefused: m.web_transport_token_refused(),
  protocolMismatch: (server, client) =>
    m.web_transport_protocol_mismatch({ machine: String(server), app: String(client) }),
}

const switchMachine = () => {
  forgetHome()
  location.reload()
}

const leave = () => {
  signOut()
  location.reload()
}

const start = async (account: RelayAccount, home: RelayMachine, machines: ReadonlyArray<RelayMachine>) => {
  saveHome(home.environmentId)
  const homeStatus = makeHomeStatus()
  const bridge = connectMachines({
    account,
    home,
    others: machines.filter((machine) => machine.environmentId !== home.environmentId),
    messages: transportMessages,
    onHomeStatus: homeStatus.set,
    signOut: leave,
  })
  Object.defineProperty(window, "hinacode", { value: bridge })
  const bar = document.body.appendChild(document.createElement("div"))
  createRoot(bar).render(<HomeStatusBar store={homeStatus} machine={home.name} onSwitch={switchMachine} />)
  await import("@/main.tsx")
}

const resume = async (): Promise<GateState | null> => {
  const account = storedAccount()
  if (account === null) return { _tag: "signedOut", error: null }
  const answer = await fetchMachines(account)
  if (answer._tag !== "machines") return { _tag: "signedOut", error: describeFailure(answer) }
  const home = answer.machines.find((machine) => machine.environmentId === storedHome())
  if (home === undefined) return { _tag: "picking", account, machines: answer.machines }
  await start(account, home, answer.machines)
  return null
}

const settings = readSettings()
await useLocale.getState().apply(settings.locale)
applyAppearance(settings.appearance)

const initial = await resume()
const rootElement = document.getElementById("root")
if (initial !== null && rootElement !== null) {
  const gate = createRoot(rootElement)
  gate.render(
    <Gate
      initial={initial}
      onPick={(account, home, machines) => {
        gate.unmount()
        void start(account, home, machines)
      }}
    />,
  )
}
