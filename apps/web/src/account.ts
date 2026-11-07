import { Option, Schema } from "effect"
import { m } from "@/paraglide/messages.js"
import { type RelayMachine, RelayMachineList } from "../../../src/shared/relayMachines.ts"

export const DEFAULT_RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "https://relay.hinacode.app"

const ACCOUNT_KEY = "hinacode.relayAccount"

export const RelayAccount = Schema.Struct({ serviceUrl: Schema.String, credential: Schema.String })
export type RelayAccount = typeof RelayAccount.Type

const decodeAccount = Schema.decodeUnknownOption(Schema.fromJsonString(RelayAccount))

export const storedAccount = (): RelayAccount | null =>
  Option.getOrNull(decodeAccount(localStorage.getItem(ACCOUNT_KEY) ?? ""))

const saveAccount = (account: RelayAccount) => localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account))

export const forgetAccount = () => localStorage.removeItem(ACCOUNT_KEY)

export const relayEndpoint = (serviceUrl: string, path: string) => `${serviceUrl.replace(/\/+$/, "")}${path}`

const postJson = (serviceUrl: string, path: string, body: unknown) =>
  fetch(relayEndpoint(serviceUrl, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

export type MachinesAnswer =
  | { readonly _tag: "machines"; readonly machines: ReadonlyArray<RelayMachine> }
  | { readonly _tag: "unauthorized" }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "badStatus"; readonly status: number }
  | { readonly _tag: "badAnswer" }

const decodeList = Schema.decodeUnknownOption(RelayMachineList)

export const fetchMachines = async (account: RelayAccount): Promise<MachinesAnswer> => {
  const response = await fetch(relayEndpoint(account.serviceUrl, "/v1/machines"), {
    headers: { Authorization: `Bearer ${account.credential}` },
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
      return m.web_signed_out()
    case "unreachable":
      return m.web_relay_unreachable()
    case "badStatus":
      return m.web_relay_bad_status({ status: String(answer.status) })
    case "badAnswer":
      return m.web_relay_bad_answer()
  }
}

const SignIn = Schema.Struct({ deviceCode: Schema.String, url: Schema.String, interval: Schema.Number })
export type SignIn = typeof SignIn.Type

const decodeSignIn = Schema.decodeUnknownOption(SignIn)
const decodeClaimed = Schema.decodeUnknownOption(Schema.Struct({ credential: Schema.String }))

export type SignInStart =
  | { readonly _tag: "started"; readonly serviceUrl: string; readonly signIn: SignIn }
  | { readonly _tag: "failed"; readonly message: string }

export const startSignIn = async (serviceUrl: string): Promise<SignInStart> => {
  const response = await postJson(serviceUrl, "/v1/sign-ins", { name: m.web_device_name() }).catch(() => null)
  if (response === null) return { _tag: "failed", message: m.web_relay_unreachable() }
  if (!response.ok) return { _tag: "failed", message: m.web_relay_bad_status({ status: String(response.status) }) }
  const signIn = Option.getOrNull(decodeSignIn(await response.json().catch(() => null)))
  return signIn === null
    ? { _tag: "failed", message: m.web_relay_bad_answer() }
    : { _tag: "started", serviceUrl, signIn }
}

export type Approval =
  | { readonly _tag: "signedIn"; readonly account: RelayAccount; readonly machines: ReadonlyArray<RelayMachine> }
  | { readonly _tag: "failed"; readonly message: string }

const pause = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

export const waitForApproval = async (serviceUrl: string, signIn: SignIn): Promise<Approval> => {
  for (;;) {
    await pause(signIn.interval)
    const response = await postJson(serviceUrl, "/v1/links/claim", { deviceCode: signIn.deviceCode }).catch(() => null)
    if (response?.status === 410) return { _tag: "failed", message: m.web_sign_in_expired() }
    if (response?.status === 403) return { _tag: "failed", message: m.web_sign_in_denied() }
    if (response === null || !response.ok || response.status === 202) continue
    const claimed = Option.getOrNull(decodeClaimed(await response.json().catch(() => null)))
    if (claimed === null) continue
    const account = { serviceUrl, credential: claimed.credential }
    saveAccount(account)
    const answer = await fetchMachines(account)
    if (answer._tag !== "machines") return { _tag: "failed", message: describeFailure(answer) }
    if (answer.machines.length === 0) return { _tag: "failed", message: m.web_no_machines() }
    return { _tag: "signedIn", account, machines: answer.machines }
  }
}

export const signOutDevice = async (account: RelayAccount) => {
  await fetch(relayEndpoint(account.serviceUrl, "/v1/device"), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${account.credential}` },
  }).catch(() => undefined)
  forgetAccount()
}
