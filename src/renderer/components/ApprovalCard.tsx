import { startTransition, useActionState } from "react"
import { RiShieldCheckLine } from "react-icons/ri"
import type { ApprovalDecision, ApprovalRequest, SessionScope } from "../../shared/agent.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"
import { errorMessage } from "../lib/errorMessage.ts"

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
      className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2 rounded-xl border border-attention/40 bg-attention/5 p-3 transition-[opacity,translate] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-y-1"
    >
      <h2 id={`approval-${request.id}`} className="flex items-center gap-2 text-sm font-semibold">
        <RiShieldCheckLine aria-hidden className="size-4 text-attention" />
        {m.approval_title({ provider: providerLabel })}
      </h2>
      <p className="text-sm">{request.title}</p>
      <pre className="max-h-40 overflow-auto rounded-sm border border-border bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
        {request.detail}
      </pre>
      {request.sessionScope && <SessionScopeNote scope={request.sessionScope} />}
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

function SessionScopeNote({ scope }: { scope: SessionScope }) {
  if (scope.kind === "tool") {
    return <p className="text-xs text-attention">{m.approval_scope_tool({ tool: scope.tool })}</p>
  }
  const label = {
    command: m.approval_scope_command(),
    path: m.approval_scope_path({ tool: scope.tool }),
    domain: m.approval_scope_domain({ tool: scope.tool }),
  }[scope.kind]
  return (
    <p className="text-xs text-muted-foreground">
      {label} <code className="font-mono break-all text-foreground">{scope.value}</code>
    </p>
  )
}
