import { type FormEvent, startTransition, useActionState, useEffect, useId, useState } from "react"
import type { SecretRequest } from "../../shared/agent.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { KeyIcon } from "./icons/KeyIcon.tsx"

/**
 * One pending `request_secret` call. The value goes to main over `secrets.respond` and nowhere else;
 * the card disappears when the turn reports `secret_resolved`.
 */
export function SecretRequestCard({ request, providerLabel }: { request: SecretRequest; providerLabel: string }) {
  const inputId = useId()
  const [value, setValue] = useState("")
  const [exists, setExists] = useState(false)
  const environment = useOpenThreadEnvironment()
  const [error, respond, isPending] = useActionState(async (_: string | null, answer: string | null) => {
    try {
      await callPromise("secrets.respond", { requestId: request.id, value: answer })
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)

  useEffect(() => {
    let cancelled = false
    void callPromise("secrets.has", { name: request.name }, { environment }).then((has) => !cancelled && setExists(has))
    return () => {
      cancelled = true
    }
  }, [request.name, environment])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = value.trim()
    if (trimmed === "") return
    startTransition(() => respond(trimmed))
  }

  return (
    <section
      aria-labelledby={`secret-${request.id}`}
      className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2 rounded-xl border border-attention/40 bg-attention/5 p-3 transition-[opacity,translate] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-y-1"
    >
      <h2 id={`secret-${request.id}`} className="flex items-center gap-2 text-sm font-semibold">
        <KeyIcon aria-hidden className="size-4 text-attention" />
        {m.secret_request_title({ provider: providerLabel })}
      </h2>
      <p className="text-sm">{request.description}</p>
      <p className="text-xs text-muted-foreground">
        {m.secret_request_name()} <code className="font-mono text-foreground">{request.name}</code>
      </p>
      {exists && <p className="text-xs text-attention">{m.secret_request_exists()}</p>}
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          {m.secret_request_value()}
        </label>
        <Input
          id={inputId}
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="w-72 font-mono"
        />
        <Button type="submit" size="sm" disabled={isPending || value.trim() === ""}>
          {exists ? m.secret_request_replace() : m.secret_request_save()}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={isPending} action={() => respond(null)}>
          {m.secret_request_decline()}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{m.secret_request_hint()}</p>
      {error && <FieldError>{error}</FieldError>}
    </section>
  )
}
