import { type FormEvent, useId, useState, useTransition } from "react"
import { errorMessage } from "../lib/errorMessage.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx"
import { Field, FieldError, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"

interface RenameDialogProps {
  readonly name: string
  readonly onRename: (name: string) => Promise<void>
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function RenameDialog({ name, onRename, open, onOpenChange }: RenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <RenameForm name={name} onRename={onRename} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({
  name: current,
  onRename,
  onSaved,
}: {
  name: string
  onRename: (name: string) => Promise<void>
  onSaved: () => void
}) {
  const [name, setName] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const inputId = useId()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        await onRename(name.trim())
        onSaved()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{m.rename_dialog_title({ name: current })}</DialogTitle>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={inputId}>{m.rename_dialog_name()}</FieldLabel>
        <Input
          id={inputId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoComplete="off"
        />
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={name.trim() === "" || name.trim() === current || pending}>
          {m.rename_dialog_save()}
        </Button>
      </DialogFooter>
    </form>
  )
}
