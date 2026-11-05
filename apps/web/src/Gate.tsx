import { startTransition, useActionState, useState, useTransition } from "react"
import { Button, buttonVariants } from "@/components/ui/button.tsx"
import { Input } from "@/components/ui/input.tsx"
import { m } from "@/paraglide/messages.js"
import type { RelayMachine } from "../../../src/shared/relayMachines.ts"
import { DEFAULT_RELAY_URL, type RelayAccount, type SignIn, startSignIn, waitForApproval } from "./account.ts"

type OnSignedIn = (account: RelayAccount, machines: ReadonlyArray<RelayMachine>) => void

export function Gate({ error, onSignedIn }: { readonly error: string | null; readonly onSignedIn: OnSignedIn }) {
  const [started, start, starting] = useActionState(
    async (_: Awaited<ReturnType<typeof startSignIn>> | null, form: FormData) =>
      startSignIn(String(form.get("serviceUrl") || DEFAULT_RELAY_URL)),
    null,
  )
  const failure = started === null ? error : started._tag === "failed" ? started.message : null

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-lg font-semibold">HinaCode</h1>
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{m.web_sign_in_title()}</h2>
          <p className="text-sm text-muted-foreground">{m.web_sign_in_body()}</p>
        </div>
        {started?._tag === "started" ? (
          <Approve serviceUrl={started.serviceUrl} signIn={started.signIn} onSignedIn={onSignedIn} />
        ) : (
          <StartForm error={failure} start={start} starting={starting} />
        )}
      </div>
    </main>
  )
}

function StartForm({
  error,
  start,
  starting,
}: {
  readonly error: string | null
  readonly start: (form: FormData) => void
  readonly starting: boolean
}) {
  const [showRelay, setShowRelay] = useState(DEFAULT_RELAY_URL !== "https://relay.hinacode.app")
  return (
    <form action={start} className="flex flex-col gap-4">
      {showRelay ? (
        <label className="flex flex-col gap-1.5 text-sm">
          {m.web_relay_url()}
          <Input name="serviceUrl" type="url" defaultValue={DEFAULT_RELAY_URL} required />
        </label>
      ) : (
        <button
          type="button"
          className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => startTransition(() => setShowRelay(true))}
        >
          {m.web_use_other_relay()}
        </button>
      )}
      <ErrorText error={error} />
      <Button type="submit" disabled={starting}>
        {m.web_sign_in()}
      </Button>
    </form>
  )
}

function Approve({
  serviceUrl,
  signIn,
  onSignedIn,
}: {
  readonly serviceUrl: string
  readonly signIn: SignIn
  readonly onSignedIn: OnSignedIn
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const [waiting, startWaiting] = useTransition()
  const wait = () =>
    startWaiting(async () => {
      const approval = await waitForApproval(serviceUrl, signIn)
      if (approval._tag === "signedIn") return onSignedIn(approval.account, approval.machines)
      startTransition(() => setFailure(approval.message))
    })

  return (
    <div className="flex flex-col gap-4">
      <a
        href={signIn.url}
        target="_blank"
        rel="noreferrer"
        onClick={waiting ? undefined : wait}
        className={buttonVariants()}
      >
        {m.web_open_sign_in_page()}
      </a>
      {waiting && <p className="text-sm text-muted-foreground">{m.web_waiting_for_approval()}</p>}
      <ErrorText error={failure} />
    </div>
  )
}

function ErrorText({ error }: { readonly error: string | null }) {
  if (error === null) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  )
}
