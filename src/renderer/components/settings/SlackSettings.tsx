import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { CheckCircleFillIcon } from "@hinacode/icons"
import { Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, type ReactNode, useState, useTransition } from "react"
import { type SlackStatus, SlackTokens } from "../../../shared/domain.ts"
import { slackAppManifestUrl } from "../../../shared/slack.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, slackStatusAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { Button, buttonVariants } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"

const areSlackTokens = Schema.is(SlackTokens)

type Run = (action: () => Promise<unknown>) => Promise<void>

export function SlackSettings() {
  const environment = useSettingsEnvironment()
  const status = useAtomValue(slackStatusAtom(environment))
  const refresh = useAtomRefresh(slackStatusAtom(environment))
  const [error, setError] = useState<string | null>(null)

  const run: Run = async (action) => {
    setError(null)
    try {
      await action()
      refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const disconnect = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      action={() => run(() => callPromise("slack.disconnect", undefined, { environment }))}
    >
      {m.settings_slack_disconnect()}
    </Button>
  )

  return (
    <Field>
      <FieldLabel>{m.settings_slack()}</FieldLabel>
      {AsyncResult.builder(status)
        .onInitial(() => <p className="text-sm text-muted-foreground">{m.settings_slack_checking()}</p>)
        .onSuccess((slack) => (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <p aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-sm">
                <StatusText status={slack} />
              </p>
              {(slack.type === "connecting" || slack.type === "connected") && disconnect}
            </div>
            {(slack.type === "disconnected" || slack.type === "failed") && (
              <>
                <div>
                  <a
                    href={slackAppManifestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    {m.settings_slack_create_app()}
                  </a>
                </div>
                <TokenForm run={run}>{slack.type === "failed" && disconnect}</TokenForm>
              </>
            )}
          </>
        ))
        .onError((cause) => <FieldError>{errorMessage(cause)}</FieldError>)
        .orElse(() => null)}
      <FieldDescription>{m.settings_slack_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

function StatusText({ status }: { status: SlackStatus }) {
  switch (status.type) {
    case "disconnected":
      return <span className="text-muted-foreground">{m.settings_slack_disconnected()}</span>
    case "connecting":
      return <span className="text-muted-foreground">{m.settings_slack_connecting()}</span>
    case "failed":
      return (
        <span className="wrap-anywhere text-destructive">{m.settings_slack_failed({ reason: status.reason })}</span>
      )
    case "connected":
      return (
        <>
          <CheckCircleFillIcon aria-hidden className="size-4 shrink-0 text-success" />
          <span className="min-w-0 wrap-anywhere">
            {m.settings_slack_connected({ team: status.team, botUser: status.botUser })}
          </span>
        </>
      )
  }
}

function TokenForm({ run, children }: { run: Run; children: ReactNode }) {
  const environment = useSettingsEnvironment()
  const [appToken, setAppToken] = useState("")
  const [botToken, setBotToken] = useState("")
  const [pending, startTransition] = useTransition()
  const tokens = { appToken: appToken.trim(), botToken: botToken.trim() }
  const ready = areSlackTokens(tokens)

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!ready) return
    startTransition(() =>
      run(async () => {
        await callPromise("slack.connect", tokens, { environment })
        setAppToken("")
        setBotToken("")
      }),
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <Field className="w-72 max-w-full">
          <FieldLabel htmlFor="settings-slack-app-token">{m.settings_slack_app_token()}</FieldLabel>
          <Input
            id="settings-slack-app-token"
            type="password"
            value={appToken}
            onChange={(event) => setAppToken(event.target.value)}
            placeholder="xapp-…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <Field className="w-72 max-w-full">
          <FieldLabel htmlFor="settings-slack-bot-token">{m.settings_slack_bot_token()}</FieldLabel>
          <Input
            id="settings-slack-bot-token"
            type="password"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            placeholder="xoxb-…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || !ready}>
          {m.settings_slack_connect()}
        </Button>
        {children}
      </div>
    </form>
  )
}
