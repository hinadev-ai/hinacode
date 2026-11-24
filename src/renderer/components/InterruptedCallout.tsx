// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live region groups a heading and its control.
import { useActionState, useId } from "react"
import { StopCircleIcon } from "@hinacode/icons"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"

export function InterruptedCallout({ threadId }: { threadId: string }) {
  const titleId = useId()
  const [error, continueTurn, isPending] = useActionState(async () => {
    try {
      await callPromise("threads.continue", { threadId })
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)

  return (
    <section
      role="status"
      aria-labelledby={titleId}
      className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-attention/30 bg-attention/10 p-3"
    >
      <h2 id={titleId} className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-attention">
        <StopCircleIcon aria-hidden className="size-4 shrink-0" />
        {m.thread_interrupted_title()}
      </h2>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        aria-busy={isPending}
        action={() => continueTurn()}
      >
        {m.thread_interrupted_continue()}
      </Button>
      {error && <FieldError className="basis-full">{error}</FieldError>}
    </section>
  )
}
