// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live region groups a heading, an explanation, and Resume.
import { useActionState, useId } from "react"
import { RefreshIcon } from "@hinacode/icons"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"

export function InterruptedCallout({ threadId }: { threadId: string }) {
  const titleId = useId()
  const [error, resume, isPending] = useActionState(async () => {
    try {
      await callPromise("threads.resume", { id: threadId })
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)
  return (
    <section
      role="status"
      aria-labelledby={titleId}
      className="mb-2 flex shrink-0 flex-col gap-2 rounded-lg border border-attention/30 bg-attention/10 p-3"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-attention">
        <RefreshIcon aria-hidden className="size-4 shrink-0" />
        {m.thread_interrupted_title()}
      </h2>
      <p className="text-sm">{m.thread_interrupted_body()}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={isPending} aria-busy={isPending} action={resume}>
          {m.thread_interrupted_resume()}
        </Button>
        {error && <FieldError className="basis-full">{error}</FieldError>}
      </div>
    </section>
  )
}
