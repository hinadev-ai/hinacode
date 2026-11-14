import { useAtomSet } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState, useTransition } from "react"
import type { Project, Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { boatThreadMachineAtom } from "../lib/rpc.ts"
import { moveDraft } from "../lib/startThread.ts"
import { m } from "../paraglide/messages.js"
import { boatCreateOf, BoatSpecFields, type ConfiguredBoatOptions, newBoatSpec } from "./BoatSpecFields.tsx"
import { BoatOptions } from "./settings/BoatMachineForm.tsx"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx"
import { FieldError, FieldGroup } from "./ui/field.tsx"

const THREAD_AUTO_STOP_HOURS = 8

export function BoatThreadDialog({
  thread,
  project,
  open,
  onOpenChange,
}: {
  thread: Thread
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{m.boat_thread_title()}</DialogTitle>
        </DialogHeader>
        <BoatOptions>
          {(options) => (
            <BoatThreadForm thread={thread} project={project} options={options} onDone={() => onOpenChange(false)} />
          )}
        </BoatOptions>
      </DialogContent>
    </Dialog>
  )
}

function BoatThreadForm({
  thread,
  project,
  options,
  onDone,
}: {
  thread: Thread
  project: Project
  options: ConfiguredBoatOptions
  onDone: () => void
}) {
  const navigate = useNavigate()
  const createMachine = useAtomSet(boatThreadMachineAtom, { mode: "promise" })
  const [spec, setSpec] = useState(() => newBoatSpec(options, THREAD_AUTO_STOP_HOURS))
  const [error, setError] = useState<string | null>(null)
  const [pending, startCreate] = useTransition()
  const create = boatCreateOf(spec, "")

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (create === null || project.repository === undefined) return
    const repository = project.repository
    startCreate(async () => {
      setError(null)
      try {
        const target = await createMachine({
          repository,
          projectName: project.name,
          setupScript: project.setupScript,
          create,
        })
        await moveDraft(thread, target.id, navigate)
        onDone()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <form onSubmit={onSubmit} className="flex min-w-0 flex-col gap-4">
      <FieldGroup>
        <BoatSpecFields idPrefix="boat-thread" options={options} spec={spec} onChange={setSpec} />
      </FieldGroup>
      {error && <FieldError className="whitespace-pre-wrap">{error}</FieldError>}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={pending} />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={pending || create === null}>
          {pending ? m.boat_machine_setting_up() : m.boat_machine_create()}
        </Button>
      </DialogFooter>
    </form>
  )
}
