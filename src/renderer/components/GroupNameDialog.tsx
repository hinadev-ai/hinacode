import { type FormEvent, useId, useState } from "react"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx"
import { Field, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"

interface GroupNameDialogProps {
  readonly name?: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSubmit: (name: string) => void
}

export function GroupNameDialog({ name, open, onOpenChange, onSubmit }: GroupNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <NameForm
          current={name}
          onSubmit={(next) => {
            onOpenChange(false)
            onSubmit(next)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function NameForm({ current, onSubmit }: { current: string | undefined; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(current ?? "")
  const inputId = useId()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(name.trim())
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          {current === undefined ? m.group_dialog_create_title() : m.group_dialog_rename_title({ group: current })}
        </DialogTitle>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={inputId}>{m.group_dialog_name()}</FieldLabel>
        <Input
          id={inputId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoComplete="off"
        />
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={name.trim() === ""}>
          {current === undefined ? m.group_dialog_create() : m.group_dialog_save()}
        </Button>
      </DialogFooter>
    </form>
  )
}
