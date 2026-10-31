// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live region groups a heading, provider message, and controls.
import { useActionState, useId } from "react"
import type { Thread } from "../../shared/domain.ts"
import { resetHasPassed, type UsageLimit } from "../../shared/limits.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { SwitchAccountButton, useAccountOptions } from "./AccountSwitch.tsx"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"
import { WarningIcon } from "./icons/WarningIcon.tsx"

export const resetCopy = (at: string, now: number): string | null => {
  const resetAt = Date.parse(at)
  if (!Number.isFinite(resetAt)) return null
  const time = new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(resetAt)
  return resetHasPassed(at, now) ? m.thread_usage_limit_was_reset({ time }) : m.thread_usage_limit_reset({ time })
}

export function UsageLimitCallout({
  thread,
  limit,
}: {
  thread: Pick<Thread, "id" | "provider" | "accountId" | "model">
  limit: UsageLimit
}) {
  const threadId = thread.id
  const titleId = useId()
  const { suggestion } = useAccountOptions(thread)
  const now = useNow()
  const reset = limit.reset
  const resetText = reset === null ? null : resetCopy(reset.at, now)
  const canResume = reset !== null && resetText !== null
  const hasReset = reset !== null && resetHasPassed(reset.at, now)

  return (
    <section
      role="status"
      aria-labelledby={titleId}
      className="mb-2 flex shrink-0 flex-col gap-2 rounded-lg border border-attention/30 bg-attention/10 p-3"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-attention">
        <WarningIcon aria-hidden className="size-4 shrink-0" />
        {limit.kind === "org_spend" ? m.thread_org_spend_limit_title() : m.thread_usage_limit_title()}
      </h2>
      <p className="text-sm break-words whitespace-pre-wrap">{limit.message}</p>
      {limit.kind === "org_spend" && <p className="text-xs text-muted-foreground">{m.thread_org_spend_limit_hint()}</p>}
      {canResume && (
        <p className="text-xs text-muted-foreground">
          <time dateTime={reset.at}>{resetText}</time>
        </p>
      )}
      {(suggestion || canResume) && (
        <div className="flex flex-wrap items-center gap-2">
          {reset?.autoResume && <p className="text-xs text-attention">{m.thread_usage_limit_scheduled()}</p>}
          {suggestion && (
            <SwitchAccountButton
              key={suggestion.id}
              threadId={threadId}
              to={suggestion}
              resend
              label={m.account_continue_on({ account: suggestion.name })}
            />
          )}
          {canResume && <ResumeButton threadId={threadId} autoResume={reset.autoResume} hasReset={hasReset} />}
        </div>
      )}
    </section>
  )
}

const resumeLabel = (autoResume: boolean, hasReset: boolean) => {
  if (autoResume) return m.thread_usage_limit_cancel_resume()
  return hasReset ? m.thread_usage_limit_try_again() : m.thread_usage_limit_resume_at_reset()
}

function ResumeButton({
  threadId,
  autoResume,
  hasReset,
}: {
  threadId: string
  autoResume: boolean
  hasReset: boolean
}) {
  const [error, setAutoResume, isPending] = useActionState(async (_: string | null, enabled: boolean) => {
    try {
      useThreads.getState().upsert(await callPromise("threads.resumeAtReset", { id: threadId, enabled }))
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        aria-busy={isPending}
        action={() => setAutoResume(!autoResume)}
      >
        {resumeLabel(autoResume, hasReset)}
      </Button>
      {error && <FieldError className="basis-full">{error}</FieldError>}
    </>
  )
}
