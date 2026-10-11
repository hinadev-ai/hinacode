import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, startTransition, useActionState, useState } from "react"
import { ProviderId } from "../../shared/agent.ts"
import type { Project } from "../../shared/domain.ts"
import { callPromise } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { Button } from "./ui/button.tsx"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx"
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"

interface NewThreadDialogProps {
  readonly project: Project
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function NewThreadDialog({ project, open, onOpenChange }: NewThreadDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.thread_dialog_title()}</DialogTitle>
          <DialogDescription>{m.thread_dialog_description({ project: project.name })}</DialogDescription>
        </DialogHeader>
        <NewThreadForm projectId={project.id} onCreated={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

const providerLabel = { claude: m.provider_claude, codex: m.provider_codex } satisfies Record<ProviderId, () => string>
const isProviderId = (value: unknown): value is ProviderId => ProviderId.literals.some((id) => id === value)

function NewThreadForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const navigate = useNavigate()
  const providers = ProviderId.literals.map((id) => ({ value: id, label: providerLabel[id]() }))
  const { defaultModel } = useSettings()
  const [provider, setProvider] = useState<ProviderId>("claude")

  const [error, submit, isPending] = useActionState(async (_: string | null, form: FormData) => {
    const chosen = form.get("provider")
    if (!isProviderId(chosen)) return String(chosen)
    try {
      const thread = await callPromise("threads.create", {
        projectId,
        title: String(form.get("title") ?? "").trim(),
        provider: chosen,
        model: String(form.get("model") ?? "").trim(),
      })
      useThreads.getState().upsert(thread)
      onCreated()
      await navigate({ to: "/thread/$threadId", params: { threadId: thread.id } })
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }, null)

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    startTransition(() => submit(form))
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="thread-title">{m.thread_title_label()}</FieldLabel>
          <Input id="thread-title" name="title" required placeholder={m.thread_title_placeholder()} />
        </Field>
        <Field>
          <FieldLabel htmlFor="thread-provider">{m.thread_provider_label()}</FieldLabel>
          <Select
            name="provider"
            items={providers}
            value={provider}
            onValueChange={(next) => isProviderId(next) && setProvider(next)}
          >
            <SelectTrigger id="thread-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <ProviderIcon provider={item.value} />
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="thread-model">{m.thread_model_label()}</FieldLabel>
          {/* Keyed so switching agent swaps in that agent's default model. */}
          <Input
            key={provider}
            id="thread-model"
            name="model"
            defaultValue={defaultModel[provider] ?? ""}
            required
            placeholder={m.thread_model_placeholder()}
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </FieldGroup>
      {error && <FieldError>{m.common_error({ message: error })}</FieldError>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={isPending}>
          {m.thread_submit()}
        </Button>
      </DialogFooter>
    </form>
  )
}
