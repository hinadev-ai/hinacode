import { startTransition, useActionState } from "react"
import { RiShieldCheckLine } from "react-icons/ri"
import type { ApprovalDecision, ApprovalRequest } from "../../shared/agent.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"
import { errorMessage } from "../lib/errorMessage.ts"

/** One pending tool approval. It disappears when the provider reports `approval_resolved`. */
export function ApprovalCard({ request, providerLabel }: { request: ApprovalRequest; providerLabel: string }) {
  const [error, respond, isPending] = useActionState(async (_: string | null, decision: ApprovalDecision) => {
    try {
      await callPromise("approvals.respond", { requestId: request.id, decision })
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)
  const choose = (decision: ApprovalDecision) => () => startTransition(() => respond(decision))

  return (
    <section
      aria-labelledby={`approval-${request.id}`}
      className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
    >
      <h2 id={`approval-${request.id}`} className="flex items-center gap-2 text-sm font-semibold">
        <RiShieldCheckLine aria-hidden className="size-4 text-amber-500" />
        {m.approval_title({ provider: providerLabel })}
      </h2>
      <p className="text-sm">{request.title}</p>
      <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
        {request.detail}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={isPending} onClick={choose("allow")}>
          {m.approval_allow()}
        </Button>
        <Button size="sm" variant="outline" disabled={isPending} onClick={choose("allow_for_session")}>
          {m.approval_allow_session()}
        </Button>
        <Button size="sm" variant="destructive" disabled={isPending} onClick={choose("deny")}>
          {m.approval_deny()}
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </section>
  )
}
