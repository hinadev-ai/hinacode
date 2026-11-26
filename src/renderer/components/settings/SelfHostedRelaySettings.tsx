import { useAtomRefresh } from "@effect/atom-react"
import { ChevronRightIcon } from "@hinacode/icons"
import { useState } from "react"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, remoteStatusAtom, settingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"

export function SelfHostedRelaySettings() {
  const { selfHostedRelay } = useSettings(null)
  return selfHostedRelay === null ? <SelfHostedRelayForm /> : <SelfHostedRelayInUse url={selfHostedRelay} />
}

function useRefreshRelay() {
  const refreshSettings = useAtomRefresh(settingsAtom(null))
  const refreshStatus = useAtomRefresh(remoteStatusAtom(null))
  return () => {
    refreshSettings()
    refreshStatus()
  }
}

function SelfHostedRelayForm() {
  const refreshRelay = useRefreshRelay()
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setError(null)
    try {
      await callPromise("relay.useSelfHosted", { url, token })
      setToken("")
      refreshRelay()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Collapsible className="flex flex-col gap-3">
      <CollapsibleTrigger className="group/trigger -mx-2 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
        />
        {m.relay_self_hosted_open()}
      </CollapsibleTrigger>
      <CollapsibleContent className="@container flex flex-col gap-3">
        <FieldDescription>{m.relay_self_hosted_hint()}</FieldDescription>
        <form onSubmit={(event) => event.preventDefault()} className="flex flex-col gap-3">
          <div className="grid gap-3 @md:grid-cols-2">
            <Field className="min-w-0">
              <FieldLabel htmlFor="self-hosted-relay-url">{m.relay_self_hosted_url_label()}</FieldLabel>
              <Input
                id="self-hosted-relay-url"
                type="url"
                value={url}
                placeholder="https://relay.example.com"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
                className="font-mono"
              />
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor="self-hosted-relay-token">{m.relay_self_hosted_token_label()}</FieldLabel>
              <Input
                id="self-hosted-relay-token"
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setToken(event.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="outline"
            className="self-start"
            disabled={url.trim() === "" || token.trim() === ""}
            action={connect}
          >
            {m.relay_self_hosted_connect()}
          </Button>
        </form>
        {error && <FieldError>{error}</FieldError>}
      </CollapsibleContent>
    </Collapsible>
  )
}

function SelfHostedRelayInUse({ url }: { url: string }) {
  const refreshRelay = useRefreshRelay()
  const [error, setError] = useState<string | null>(null)

  const stop = async () => {
    setError(null)
    try {
      await callPromise("relay.stopSelfHosted", undefined)
      refreshRelay()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium">{m.relay_self_hosted_label()}</p>
          <p className="truncate font-mono text-sm text-muted-foreground" title={url}>
            {url}
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" action={stop}>
          {m.relay_self_hosted_stop()}
        </Button>
      </div>
      <FieldDescription>{m.relay_self_hosted_stop_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}
