import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, startTransition, useActionState, useState } from "react"
import { RiFolderOpenLine } from "react-icons/ri"
import { callPromise, createProjectAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { Textarea } from "./ui/textarea.tsx"
import { errorMessage } from "../lib/errorMessage.ts"

interface AddProjectDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.project_dialog_title()}</DialogTitle>
          <DialogDescription>{m.project_dialog_description()}</DialogDescription>
        </DialogHeader>
        {/* Inside the popup so the form state resets every time the dialog opens. */}
        <AddProjectForm onCreated={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? ""

function AddProjectForm({ onCreated }: { onCreated: () => void }) {
  const createProject = useAtomSet(createProjectAtom, { mode: "promise" })
  const [name, setName] = useState("")
  const [rootPath, setRootPath] = useState("")

  const [error, submit, isPending] = useActionState(async (_: string | null, form: FormData) => {
    const setupScript = String(form.get("setupScript") ?? "").trim()
    try {
      await createProject({ name: name.trim(), rootPath: rootPath.trim(), setupScript: setupScript || null })
    } catch (cause) {
      return errorMessage(cause)
    }
    onCreated()
    return null
  }, null)

  const browse = async () => {
    const picked = await callPromise("dialog.pickFolder", undefined)
    if (!picked) return
    setRootPath(picked)
    if (!name.trim()) setName(basename(picked))
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    startTransition(() => submit(form))
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-root">{m.project_root_label()}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="project-root"
              required
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder={m.project_root_placeholder()}
              spellCheck={false}
            />
            <Button type="button" variant="outline" onClick={browse}>
              <RiFolderOpenLine aria-hidden />
              {m.project_root_browse()}
            </Button>
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="project-name">{m.project_name_label()}</FieldLabel>
          <Input
            id="project-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={m.project_name_placeholder()}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-setup">
            {m.project_setup_label()}
            <span className="font-normal text-muted-foreground">{m.project_setup_optional()}</span>
          </FieldLabel>
          <Textarea
            id="project-setup"
            name="setupScript"
            rows={4}
            className="font-mono text-xs"
            placeholder={m.project_setup_placeholder()}
            spellCheck={false}
          />
          <FieldDescription>
            {m.project_setup_hint()}
            <span className="mt-1 flex flex-col gap-0.5">
              <span>
                <code className="font-mono text-foreground">$KKCODE_ROOT_PATH</code> {m.project_setup_root_var()}
              </span>
              <span>
                <code className="font-mono text-foreground">$KKCODE_WORKTREE_PATH</code>{" "}
                {m.project_setup_worktree_var()}
              </span>
            </span>
          </FieldDescription>
        </Field>
      </FieldGroup>
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={isPending}>
          {m.project_submit()}
        </Button>
      </DialogFooter>
    </form>
  )
}
