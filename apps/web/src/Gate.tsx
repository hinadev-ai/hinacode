import { useActionState, useState } from "react"
import { Button } from "@/components/ui/button.tsx"
import { Input } from "@/components/ui/input.tsx"
import { m } from "@/paraglide/messages.js"
import type { RelayMachine } from "../../../src/shared/relayMachines.ts"
import { DEFAULT_RELAY_URL, fetchMachines, type MachinesAnswer, type RelayAccount, saveAccount } from "./account.ts"

export type GateState =
  | { readonly _tag: "signedOut"; readonly error: string | null }
  | { readonly _tag: "picking"; readonly account: RelayAccount; readonly machines: ReadonlyArray<RelayMachine> }

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

export function Gate({
  initial,
  onPick,
}: {
  readonly initial: GateState
  readonly onPick: (account: RelayAccount, home: RelayMachine, machines: ReadonlyArray<RelayMachine>) => void
}) {
  const [state, signIn, signingIn] = useActionState(async (_: GateState, form: FormData): Promise<GateState> => {
    const account = {
      serviceUrl: String(form.get("serviceUrl") || DEFAULT_RELAY_URL),
      ownerToken: String(form.get("ownerToken")).trim(),
    }
    const answer = await fetchMachines(account)
    if (answer._tag !== "machines") return { _tag: "signedOut", error: describeFailure(answer) }
    saveAccount(account)
    return { _tag: "picking", account, machines: answer.machines }
  }, initial)

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-lg font-semibold">HinaCode</h1>
        {state._tag === "signedOut" ? (
          <SignIn error={state.error} signIn={signIn} signingIn={signingIn} />
        ) : (
          <MachinePicker machines={state.machines} onPick={(home) => onPick(state.account, home, state.machines)} />
        )}
      </div>
    </main>
  )
}

function SignIn({
  error,
  signIn,
  signingIn,
}: {
  readonly error: string | null
  readonly signIn: (form: FormData) => void
  readonly signingIn: boolean
}) {
  const [showRelay, setShowRelay] = useState(DEFAULT_RELAY_URL !== "https://relay.hinacode.app")
  return (
    <form action={signIn} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{m.web_sign_in_title()}</h2>
        <p className="text-sm text-muted-foreground">{m.web_sign_in_body()}</p>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        {m.web_owner_token()}
        <Input name="ownerToken" type="password" required autoComplete="current-password" />
      </label>
      {showRelay ? (
        <label className="flex flex-col gap-1.5 text-sm">
          {m.web_relay_url()}
          <Input name="serviceUrl" type="url" defaultValue={DEFAULT_RELAY_URL} required />
        </label>
      ) : (
        <button
          type="button"
          className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => setShowRelay(true)}
        >
          {m.web_use_other_relay()}
        </button>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={signingIn}>
        {m.web_sign_in()}
      </Button>
    </form>
  )
}

function MachinePicker({
  machines,
  onPick,
}: {
  readonly machines: ReadonlyArray<RelayMachine>
  readonly onPick: (machine: RelayMachine) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{m.web_pick_machine_title()}</h2>
        <p className="text-sm text-muted-foreground">
          {machines.length === 0 ? m.web_no_machines() : m.web_pick_machine_body()}
        </p>
      </div>
      <ul className="flex flex-col gap-1">
        {machines.map((machine) => (
          <li key={machine.environmentId}>
            <button
              type="button"
              className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-start hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              onClick={() => onPick(machine)}
            >
              <span className="text-sm font-medium">{machine.name}</span>
              <span className="truncate text-xs text-muted-foreground">{machine.pairing.relay}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
