import { Option, Schema } from "effect"
import { m } from "@/paraglide/messages.js"
import { type RelayMachine, RelayMachineList } from "../../../src/shared/relayMachines.ts"

export const DEFAULT_RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "https://relay.hinacode.app"

const ACCOUNT_KEY = "hinacode.relayAccount"

export const RelayAccount = Schema.Struct({ serviceUrl: Schema.String, ownerToken: Schema.String })
export type RelayAccount = typeof RelayAccount.Type

const decodeAccount = Schema.decodeUnknownOption(Schema.fromJsonString(RelayAccount))

export const storedAccount = (): RelayAccount | null =>
  Option.getOrNull(decodeAccount(localStorage.getItem(ACCOUNT_KEY) ?? ""))

export const saveAccount = (account: RelayAccount) => localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account))

export const signOut = () => localStorage.removeItem(ACCOUNT_KEY)

export type MachinesAnswer =
  | { readonly _tag: "machines"; readonly machines: ReadonlyArray<RelayMachine> }
  | { readonly _tag: "unauthorized" }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "badStatus"; readonly status: number }
  | { readonly _tag: "badAnswer" }

const decodeList = Schema.decodeUnknownOption(RelayMachineList)

export const fetchMachines = async (account: RelayAccount): Promise<MachinesAnswer> => {
  const response = await fetch(`${account.serviceUrl.replace(/\/+$/, "")}/v1/machines`, {
    headers: { Authorization: `Bearer ${account.ownerToken}` },
  }).catch(() => null)
  if (response === null) return { _tag: "unreachable" }
  if (response.status === 401) return { _tag: "unauthorized" }
  if (!response.ok) return { _tag: "badStatus", status: response.status }
  const list = Option.getOrNull(decodeList(await response.json().catch(() => null)))
  return list === null ? { _tag: "badAnswer" } : { _tag: "machines", machines: list.machines }
}

export const describeFailure = (answer: Exclude<MachinesAnswer, { _tag: "machines" }>) => {
  switch (answer._tag) {
    case "unauthorized":
      return m.web_relay_refused()
    case "unreachable":
      return m.web_relay_unreachable()
    case "badStatus":
      return m.web_relay_bad_status({ status: String(answer.status) })
    case "badAnswer":
      return m.web_relay_bad_answer()
  }
}
