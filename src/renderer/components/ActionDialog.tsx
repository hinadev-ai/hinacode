import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, startTransition, useActionState } from "react"
import type { Project, ProjectAction } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { type EnvironmentId, updateProjectAtom, updateSettingsAtom } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx"
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.tsx"
import { Textarea } from "./ui/textarea.tsx"

export type ActionScope = "project" | "global"

export interface ActionTarget {
  readonly scope: ActionScope
  readonly index: number | null
}

interface ActionDialogProps {
  readonly project: Project
  readonly environment: EnvironmentId
  readonly target: ActionTarget
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function ActionDialog({ project, environment, target, open, onOpenChange }: ActionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{target.index === null ? m.action_new_title() : m.action_edit_title()}</DialogTitle>
        </DialogHeader>
        <ActionForm project={project} environment={environment} target={target} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

const without = (actions: ReadonlyArray<ProjectAction>, index: number) =>
  actions.filter((_action, position) => position !== index)

const replaced = (actions: ReadonlyArray<ProjectAction>, index: number, next: ProjectAction) =>
  actions.map((current, position) => (position === index ? next : current))

interface ActionFormProps {
  readonly project: Project
  readonly environment: EnvironmentId
  readonly target: ActionTarget
  readonly onSaved: () => void
}

function ActionForm({ project, environment, target, onSaved }: ActionFormProps) {
  const updateProject = useAtomSet(updateProjectAtom, { mode: "promise" })
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const lists: Record<ActionScope, ReadonlyArray<ProjectAction>> = {
    project: project.actions,
    global: useSettings(environment).actions,
  }
  const writers: Record<ActionScope, (actions: ReadonlyArray<ProjectAction>) => Promise<unknown>> = {
    project: (actions) => updateProject({ id: project.id, actions }),
    global: (actions) => updateSettings({ actions }),
  }
  const action = target.index === null ? undefined : lists[target.scope][target.index]
  const projectScoped = project.kind === "folder"

  const save = async (changes: Partial<Record<ActionScope, ReadonlyArray<ProjectAction>>>) => {
    try {
      for (const [scope, actions] of Object.entries(changes) as Array<[ActionScope, ReadonlyArray<ProjectAction>]>) {
        await writers[scope](actions)
      }
    } catch (cause) {
      return errorMessage(cause)
    }
    onSaved()
    return null
  }

  const [error, submit, isPending] = useActionState(async (_previous: string | null, form: FormData | "delete") => {
    const { scope, index } = target
    if (form === "delete") return index === null ? null : save({ [scope]: without(lists[scope], index) })
    const next = { name: String(form.get("name")).trim(), command: String(form.get("command")).trim() }
    const nextScope: ActionScope = form.get("scope") === "project" ? "project" : "global"
    if (index === null) return save({ [nextScope]: [...lists[nextScope], next] })
    if (nextScope === scope) return save({ [scope]: replaced(lists[scope], index, next) })
    return save({ [nextScope]: [...lists[nextScope], next], [scope]: without(lists[scope], index) })
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
        {projectScoped && (
          <Field>
            <FieldLabel id="action-scope">{m.action_scope_label()}</FieldLabel>
            <RadioGroup
              name="scope"
              aria-labelledby="action-scope"
              defaultValue={target.scope}
              className="flex flex-wrap gap-x-6 gap-y-2"
            >
              <ScopeOption value="project" label={project.name} />
              <ScopeOption value="global" label={m.action_scope_global()} />
            </RadioGroup>
          </Field>
        )}
      </FieldGroup>
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        {action && (
          <Button
            type="button"
            variant="destructive"
            className="mr-auto"
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

function ScopeOption({ value, label }: { value: ActionScope; label: string }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <RadioGroupItem value={value} />
      <span className="truncate">{label}</span>
    </label>
  )
}
