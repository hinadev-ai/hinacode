import { useActionState, useState } from "react"
import { Button } from "@/components/ui/button.tsx"
import { Input } from "@/components/ui/input.tsx"
import { m } from "@/paraglide/messages.js"
import type { RelayMachine } from "../../../src/shared/relayMachines.ts"
import { DEFAULT_RELAY_URL, describeFailure, fetchMachines, type RelayAccount, saveAccount } from "./account.ts"

export function Gate({
  error,
  onSignedIn,
}: {
  readonly error: string | null
  readonly onSignedIn: (account: RelayAccount, machines: ReadonlyArray<RelayMachine>) => void
}) {
  const [failure, signIn, signingIn] = useActionState(async (_: string | null, form: FormData) => {
    const account = {
      serviceUrl: String(form.get("serviceUrl") || DEFAULT_RELAY_URL),
      ownerToken: String(form.get("ownerToken")).trim(),
    }
    const answer = await fetchMachines(account)
    if (answer._tag !== "machines") return describeFailure(answer)
    if (answer.machines.length === 0) return m.web_no_machines()
    saveAccount(account)
    onSignedIn(account, answer.machines)
    return null
  }, error)

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-lg font-semibold">HinaCode</h1>
        <SignIn error={failure} signIn={signIn} signingIn={signingIn} />
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
