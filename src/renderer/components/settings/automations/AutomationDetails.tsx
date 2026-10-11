import { errorMessage } from "../../../lib/errorMessage.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, startTransition, useActionState, useId, useState } from "react"
import type { Automation, AutomationRun, AutomationTriggerType } from "../../../../shared/domain.ts"
import { automationRunsAtom, callPromise, webhookUrlAtom } from "../../../lib/rpc.ts"
import { useSettings } from "../../../lib/settings.ts"
import { m } from "../../../paraglide/messages.js"
import { Button } from "../../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../../ui/field.tsx"
import { Textarea } from "../../ui/textarea.tsx"
import { CopyField, formatTime, RunStatusBadge } from "./shared.tsx"
import { SkeletonList } from "../../ui/skeleton.tsx"

/** Webhook URL, Run now and recent runs for one automation. */
export function AutomationDetails({ automation }: { automation: Automation }) {
  return (
    <div className="flex flex-col gap-5 border-t border-border pt-4">
      {automation.trigger.type === "webhook" && <WebhookUrlField automationId={automation.id} />}
      <RunNowForm automation={automation} />
      <RecentRuns automationId={automation.id} />
    </div>
  )
}

export function WebhookUrlField({ automationId }: { automationId: string }) {
  const id = useId()
  const result = useAtomValue(webhookUrlAtom(automationId))
  const { automations: listener } = useSettings()

  return (
    <Field>
      <FieldLabel htmlFor={id}>{m.automations_webhook_url_label()}</FieldLabel>
      {AsyncResult.builder(result)
        .onInitial(() => <p className="text-sm text-muted-foreground">{m.automations_loading()}</p>)
        .onSuccess(({ url, listenError }) => (
          <>
            <CopyField id={id} value={url} copyLabel={m.automations_copy_url()} />
            {listenError && <FieldError>{m.automations_listen_failed({ message: listenError })}</FieldError>}
          </>
        ))
        .onError((cause) => <FieldError>{errorMessage(cause)}</FieldError>)
        .orElse(() => null)}
      <FieldDescription>
        {listener.bindHost === "0.0.0.0" ? m.automations_webhook_url_lan_hint() : m.automations_webhook_url_hint()}
      </FieldDescription>
    </Field>
  )
}

const samplePayloads = {
  webhook: {
    body: {
      action: "opened",
      issue: { number: 1, title: "Example issue", html_url: "https://github.com/owner/repo/issues/1" },
    },
    headers: {},
  },
  "github.issue": {
    issue: {
      number: 1,
      identifier: "#1",
      title: "Example issue",
      body: "Steps to reproduce…",
      url: "https://github.com/owner/repo/issues/1",
    },
  },
  "linear.issue": {
    issue: {
      identifier: "ENG-1",
      title: "Example issue",
      body: "Steps to reproduce…",
      url: "https://linear.app/team/issue/ENG-1",
    },
  },
  "slack.mention": { message: { text: "<@U0123ABCD> can you take a look?", channel: "dev", permalink: "" } },
} satisfies Record<AutomationTriggerType, unknown>

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

type RunNowState =
  | { readonly kind: "ran"; readonly run: AutomationRun }
  | { readonly kind: "error"; readonly message: string }
  | null

function RunNowForm({ automation }: { automation: Automation }) {
  const id = useId()
  const [payload, setPayload] = useState(() => JSON.stringify(samplePayloads[automation.trigger.type], null, 2))
  const [state, submit, isPending] = useActionState(async (_: RunNowState, text: string): Promise<RunNowState> => {
    const parsed = parseJson(text)
    if (!parsed.ok) return { kind: "error", message: m.automations_payload_invalid() }
    try {
      const run = await callPromise("automations.runNow", { id: automation.id, payload: parsed.value })
      return { kind: "ran", run }
    } catch (cause) {
      return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) }
    }
  }, null)

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startTransition(() => submit(payload))
  }

  return (
    <form onSubmit={onSubmit}>
      <Field>
        <FieldLabel htmlFor={id}>{m.automations_payload_label()}</FieldLabel>
        <Textarea
          id={id}
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          spellCheck={false}
          className="max-h-60 min-h-24 font-mono text-xs md:text-xs"
        />
        <FieldDescription>{m.automations_payload_hint()}</FieldDescription>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="outline" size="sm" disabled={isPending}>
            {isPending ? m.automations_running() : m.automations_run_now()}
          </Button>
          <p aria-live="polite" className="text-sm">
            {state?.kind === "ran" && <RunOutcome run={state.run} />}
          </p>
        </div>
        {state?.kind === "error" && <FieldError>{errorMessage(state.message)}</FieldError>}
      </Field>
    </form>
  )
}

function RunOutcome({ run }: { run: AutomationRun }) {
  if (run.threadId !== null) {
    return (
      <Link to="/thread/$threadId" params={{ threadId: run.threadId }} className="underline underline-offset-4">
        {m.automations_open_thread()}
      </Link>
    )
  }
  return <span className="text-destructive">{run.error ?? m.automations_run_skipped()}</span>
}

function RecentRuns({ automationId }: { automationId: string }) {
  const runs = useAtomValue(automationRunsAtom(automationId))
  const refresh = useAtomRefresh(automationRunsAtom(automationId))

  return (
    <section aria-label={m.automations_runs_title()} className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{m.automations_runs_title()}</h4>
      {AsyncResult.builder(runs)
        .onInitial(() => <SkeletonList label={m.automations_loading()} rowClassName="h-8" />)
        .onSuccess((list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.automations_runs_empty()}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {list.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          ),
        )
        .onError((cause) => (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{errorMessage(cause)}</p>
            <Button variant="ghost" size="sm" onClick={refresh}>
              {m.common_retry()}
            </Button>
          </div>
        ))
        .orElse(() => null)}
    </section>
  )
}

function RunRow({ run }: { run: AutomationRun }) {
  return (
    <li className="flex flex-col gap-1 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <RunStatusBadge status={run.status} />
        <time dateTime={run.createdAt} className="text-muted-foreground tabular-nums">
          {formatTime(run.createdAt)}
        </time>
        {run.threadId !== null && (
          <Link
            to="/thread/$threadId"
            params={{ threadId: run.threadId }}
            className="ml-auto underline underline-offset-4"
          >
            {m.automations_open_thread()}
          </Link>
        )}
      </div>
      {run.status === "skipped" && run.eventKey !== null && (
        <p className="truncate text-muted-foreground" title={run.eventKey}>
          {m.automations_run_duplicate({ key: run.eventKey })}
        </p>
      )}
      {run.error !== null && <p className="break-words whitespace-pre-wrap text-destructive">{run.error}</p>}
    </li>
  )
}
