import { Option, Schema } from "effect"
import { m } from "@/paraglide/messages.js"
import { type Clerk, loadClerk } from "./clerk.ts"
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

const RELAY_KEY = "hinacode.relayUrl"

export const chosenRelay = () => sessionStorage.getItem(RELAY_KEY) ?? DEFAULT_RELAY_URL

export const chooseRelay = (serviceUrl: string) => sessionStorage.setItem(RELAY_KEY, serviceUrl)

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

type Answer<A> = { readonly _tag: "ok"; readonly value: A } | { readonly _tag: "failed"; readonly message: string }

const readAnswer = async <A>(
  request: Promise<Response>,
  decode: (input: unknown) => Option.Option<A>,
): Promise<Answer<A>> => {
  const response = await request.catch(() => null)
  if (response === null) return { _tag: "failed", message: m.web_relay_unreachable() }
  if (!response.ok) return { _tag: "failed", message: m.web_relay_bad_status({ status: String(response.status) }) }
  const value = decode(await response.json().catch(() => null))
  return Option.isSome(value)
    ? { _tag: "ok", value: value.value }
    : { _tag: "failed", message: m.web_relay_bad_answer() }
}

const decodeConfig = Schema.decodeUnknownOption(Schema.Struct({ clerkPublishableKey: Schema.String }))
const decodeDevice = Schema.decodeUnknownOption(Schema.Struct({ credential: Schema.String }))

export const fetchClerkKey = async (serviceUrl: string): Promise<Answer<string>> => {
  const config = await readAnswer(fetch(relayEndpoint(serviceUrl, "/v1/config")), decodeConfig)
  return config._tag === "ok" ? { _tag: "ok", value: config.value.clerkPublishableKey } : config
}

export type Approval =
  | { readonly _tag: "signedIn"; readonly account: RelayAccount; readonly machines: ReadonlyArray<RelayMachine> }
  | { readonly _tag: "failed"; readonly message: string }

const approveAnswer = (account: RelayAccount, answer: MachinesAnswer): Approval => {
  if (answer._tag !== "machines") return { _tag: "failed", message: describeFailure(answer) }
  if (answer.machines.length === 0) return { _tag: "failed", message: m.web_no_machines() }
  return { _tag: "signedIn", account, machines: answer.machines }
}

export const createDevice = async (serviceUrl: string, sessionToken: string): Promise<Approval> => {
  const device = await readAnswer(
    fetch(relayEndpoint(serviceUrl, "/v1/devices"), {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: m.web_device_name() }),
    }),
    decodeDevice,
  )
  if (device._tag === "failed") return device
  const account = { serviceUrl, credential: device.value.credential }
  saveAccount(account)
  return approveAnswer(account, await fetchMachines(account))
}

const signInWithClerk = async (serviceUrl: string, clerk: Clerk): Promise<Approval> => {
  const stored = storedAccount()
  if (stored?.serviceUrl === serviceUrl) {
    const answer = await fetchMachines(stored)
    if (answer._tag !== "unauthorized") return approveAnswer(stored, answer)
    forgetAccount()
  }
  const sessionToken = await clerk.session?.getToken().catch(() => null)
  if (!sessionToken) return { _tag: "failed", message: m.web_sign_in_unavailable() }
  return createDevice(serviceUrl, sessionToken)
}

export type SignInStep =
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "signIn"; readonly clerk: Clerk }
  | { readonly _tag: "signingIn"; readonly clerk: Clerk; readonly approval: Promise<Approval> }

export interface SignInAttempt {
  readonly serviceUrl: string
  readonly step: Promise<SignInStep>
}

export type OnSignedIn = (account: RelayAccount, machines: ReadonlyArray<RelayMachine>) => void

const openClerk = async (serviceUrl: string): Promise<Answer<Clerk>> => {
  const key = await fetchClerkKey(serviceUrl)
  if (key._tag === "failed") return key
  const clerk = await loadClerk(key.value).catch(() => null)
  return clerk === null ? { _tag: "failed", message: m.web_sign_in_unavailable() } : { _tag: "ok", value: clerk }
}

const nextStep = async (serviceUrl: string, onSignedIn: OnSignedIn): Promise<SignInStep> => {
  const clerk = await openClerk(serviceUrl)
  if (clerk._tag === "failed") return clerk
  if (!clerk.value.isSignedIn) return { _tag: "signIn", clerk: clerk.value }
  const approval = signInWithClerk(serviceUrl, clerk.value)
  void approval.then((result) => {
    if (result._tag === "signedIn") onSignedIn(result.account, result.machines)
  })
  return { _tag: "signingIn", clerk: clerk.value, approval }
}

export const openSignIn = (serviceUrl: string, onSignedIn: OnSignedIn): SignInAttempt => ({
  serviceUrl,
  step: nextStep(serviceUrl, onSignedIn),
})

const endDevice = async (account: RelayAccount) => {
  await fetch(relayEndpoint(account.serviceUrl, "/v1/device"), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${account.credential}` },
  }).catch(() => undefined)
  forgetAccount()
}

export const switchAccount = async (clerk: Clerk) => {
  const account = storedAccount()
  if (account !== null) await endDevice(account)
  await clerk.signOut()
}

export const signOutDevice = async (account: RelayAccount) => {
  const clerk = await openClerk(account.serviceUrl)
  if (clerk._tag === "failed") throw new Error(clerk.message)
  await clerk.value.signOut()
  await endDevice(account)
}
