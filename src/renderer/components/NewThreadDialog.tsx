import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, startTransition, useActionState, useState } from "react"
import { ProviderId } from "../../shared/agent.ts"
import type { Project } from "../../shared/domain.ts"
import { callPromise, currentBranchAtom } from "../lib/rpc.ts"
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
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"
import { Switch } from "./ui/switch.tsx"

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

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "")

function NewThreadForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const navigate = useNavigate()
  const providers = ProviderId.literals.map((id) => ({ value: id, label: providerLabel[id]() }))
  const [title, setTitle] = useState("")
  const [inWorktree, setInWorktree] = useState(false)
  const { defaultModel } = useSettings()
  const [provider, setProvider] = useState<ProviderId>("claude")

  const [error, submit, isPending] = useActionState(async (_: string | null, form: FormData) => {
    const chosen = form.get("provider")
    if (!isProviderId(chosen)) return String(chosen)
    try {
      const thread = await callPromise("threads.create", {
        projectId,
        title: title.trim(),
        provider: chosen,
        model: String(form.get("model") ?? "").trim(),
        worktree: inWorktree
          ? { branch: String(form.get("branch") ?? "").trim(), baseRef: String(form.get("baseRef") ?? "").trim() }
          : undefined,
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
          <Input
            id="thread-title"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={m.thread_title_placeholder()}
          />
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
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="thread-worktree">{m.thread_worktree_label()}</FieldLabel>
            <FieldDescription>{m.thread_worktree_hint()}</FieldDescription>
          </FieldContent>
          <Switch id="thread-worktree" checked={inWorktree} onCheckedChange={setInWorktree} />
        </Field>
        {inWorktree && <WorktreeFields projectId={projectId} title={title} />}
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

/** Branch and base ref inputs. Both follow their defaults until the user edits them. */
function WorktreeFields({ projectId, title }: { projectId: string; title: string }) {
  const currentBranch = useAtomValue(currentBranchAtom(projectId))
  // Keeps titles without ASCII letters, such as Chinese ones, from all landing on the same branch.
  const [fallbackSlug] = useState(() => `thread-${Math.random().toString(36).slice(2, 7)}`)
  const [branch, setBranch] = useState<string | null>(null)
  const [baseRef, setBaseRef] = useState<string | null>(null)

  const defaultBranch = `kk/${slugify(title) || fallbackSlug}`
  const defaultBaseRef = AsyncResult.getOrElse(currentBranch, () => "")

  return (
    <>
      <Field>
        <FieldLabel htmlFor="thread-branch">{m.thread_branch_label()}</FieldLabel>
        <Input
          id="thread-branch"
          name="branch"
          required
          value={branch ?? defaultBranch}
          onChange={(event) => setBranch(event.target.value)}
          spellCheck={false}
          className="font-mono"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="thread-base-ref">{m.thread_base_ref_label()}</FieldLabel>
        <Input
          id="thread-base-ref"
          name="baseRef"
          required
          value={baseRef ?? defaultBaseRef}
          onChange={(event) => setBaseRef(event.target.value)}
          placeholder={m.thread_base_ref_placeholder()}
          spellCheck={false}
          className="font-mono"
        />
      </Field>
    </>
  )
}
