// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live region groups a heading, provider message, and controls.
import { startTransition, useActionState, useId } from "react"
import { RiErrorWarningLine } from "react-icons/ri"
import type { UsageLimit } from "../../shared/limits.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"

export function UsageLimitCallout({ threadId, limit }: { threadId: string; limit: UsageLimit }) {
  const titleId = useId()
  const [error, setAutoResume, isPending] = useActionState(async (_: string | null, enabled: boolean) => {
    try {
      const thread = await callPromise("threads.resumeAtReset", { id: threadId, enabled })
      useThreads.getState().upsert(thread)
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)
  const reset = limit.reset
  const resetDate = reset === null ? null : new Date(reset.at)
  const resetTime =
    resetDate !== null && Number.isFinite(resetDate.getTime())
      ? new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(resetDate)
      : null

  return (
    <section
      role="status"
      aria-labelledby={titleId}
      className="mb-2 flex w-[calc(100%-1.5rem)] max-w-3xl shrink-0 self-center flex-col gap-2 rounded-lg border border-attention/30 bg-attention/10 p-3"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-attention">
        <RiErrorWarningLine aria-hidden className="size-4 shrink-0" />
        {limit.kind === "org_spend" ? m.thread_org_spend_limit_title() : m.thread_usage_limit_title()}
      </h2>
      <p className="text-sm break-words whitespace-pre-wrap">{limit.message}</p>
      {limit.kind === "org_spend" && <p className="text-xs text-muted-foreground">{m.thread_org_spend_limit_hint()}</p>}
      {reset !== null && resetTime !== null && (
        <>
          <p className="text-xs text-muted-foreground">
            <time dateTime={reset.at}>{m.thread_usage_limit_reset({ time: resetTime })}</time>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {reset.autoResume && <p className="text-xs text-attention">{m.thread_usage_limit_scheduled()}</p>}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              aria-busy={isPending}
              onClick={() => startTransition(() => setAutoResume(!reset.autoResume))}
            >
              {reset.autoResume ? m.thread_usage_limit_cancel_resume() : m.thread_usage_limit_resume_at_reset()}
            </Button>
          </div>
        </>
      )}
      {error && <FieldError>{error}</FieldError>}
    </section>
  )
}
