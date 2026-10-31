import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, startTransition, useActionState } from "react"
import type { Project, ProjectAction } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { updateProjectAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx"
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { Textarea } from "./ui/textarea.tsx"

interface ActionDialogProps {
  readonly project: Project
  readonly index: number | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function ActionDialog({ project, index, open, onOpenChange }: ActionDialogProps) {
  const action = index === null ? undefined : project.actions[index]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{action ? m.action_edit_title() : m.action_new_title()}</DialogTitle>
        </DialogHeader>
        <ActionForm project={project} index={index} action={action} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

interface ActionFormProps {
  readonly project: Project
  readonly index: number | null
  readonly action: ProjectAction | undefined
  readonly onSaved: () => void
}

function ActionForm({ project, index, action, onSaved }: ActionFormProps) {
  const updateProject = useAtomSet(updateProjectAtom, { mode: "promise" })

  const save = async (actions: ReadonlyArray<ProjectAction>) => {
    try {
      await updateProject({ id: project.id, actions })
    } catch (cause) {
      return errorMessage(cause)
    }
    onSaved()
    return null
  }

  const [error, submit, isPending] = useActionState(async (_previous: string | null, form: FormData | "delete") => {
    if (form === "delete") return save(project.actions.filter((_action, position) => position !== index))
    const next = { name: String(form.get("name")).trim(), command: String(form.get("command")).trim() }
    return save(
      index === null
        ? [...project.actions, next]
        : project.actions.map((current, position) => (position === index ? next : current)),
    )
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
          <FieldLabel htmlFor="action-name">{m.action_name_label()}</FieldLabel>
          <Input
            id="action-name"
            name="name"
            required
            pattern=".*\S.*"
            defaultValue={action?.name}
            placeholder={m.action_name_placeholder()}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="action-command">{m.action_command_label()}</FieldLabel>
          <Textarea
            id="action-command"
            name="command"
            required
            rows={3}
            defaultValue={action?.command}
            placeholder={m.action_command_placeholder()}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
      </FieldGroup>
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        {action && (
          <Button
            type="button"
            variant="destructive"
            className="sm:mr-auto"
            disabled={isPending}
            action={() => submit("delete")}
          >
            {m.action_delete()}
          </Button>
        )}
        <DialogClose render={<Button type="button" variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={isPending}>
          {m.project_save()}
        </Button>
      </DialogFooter>
    </form>
  )
}
