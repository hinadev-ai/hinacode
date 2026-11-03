import "@/index.css"
import { createRoot } from "react-dom/client"
import { applyAppearance } from "@/lib/appearance.ts"
import { m } from "@/paraglide/messages.js"
import { useLocale } from "@/stores/locale.ts"
import type { RelayMachine } from "../../../src/shared/relayMachines.ts"
import type { TransportMessages } from "../../../src/shared/transport.ts"
import { fetchMachines, type RelayAccount, signOut, storedAccount } from "./account.ts"
import { connectMachines } from "./bridge.ts"
import { readSettings } from "./browser.ts"
import { describeFailure, Gate } from "./Gate.tsx"
import { serveResources } from "./resources.ts"

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

const leave = () => {
  signOut()
  location.reload()
}

const start = async (account: RelayAccount, machines: ReadonlyArray<RelayMachine>) => {
  const bridge = connectMachines({ account, machines, messages: transportMessages, signOut: leave })
  Object.defineProperty(window, "hinacode", { value: bridge })
  await serveResources(bridge).catch((cause: unknown) => console.error("Attachments and previews will not load", cause))
  await import("@/main.tsx")
}

type Resumed = { readonly _tag: "started" } | { readonly _tag: "signIn"; readonly error: string | null }

const resume = async (): Promise<Resumed> => {
  const account = storedAccount()
  if (account === null) return { _tag: "signIn", error: null }
  const answer = await fetchMachines(account)
  if (answer._tag !== "machines") return { _tag: "signIn", error: describeFailure(answer) }
  if (answer.machines.length === 0) return { _tag: "signIn", error: m.web_no_machines() }
  await start(account, answer.machines)
  return { _tag: "started" }
}

const settings = readSettings()
await useLocale.getState().apply(settings.locale)
applyAppearance(settings.appearance)

const resumed = await resume()
const rootElement = document.getElementById("root")
if (resumed._tag === "signIn" && rootElement !== null) {
  const gate = createRoot(rootElement)
  gate.render(
    <Gate
      error={resumed.error}
      onSignedIn={(account, machines) => {
        gate.unmount()
        void start(account, machines)
      }}
    />,
  )
}
