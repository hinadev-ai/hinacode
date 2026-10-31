import { errorMessage } from "../../../lib/errorMessage.ts"
import { cn } from "cn"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState, useTransition } from "react"
import type { Automation, Project } from "../../../../shared/domain.ts"
import { automationsAtom, callPromise, projectsAtom, updateSettingsAtom } from "../../../lib/rpc.ts"
import { useSettings } from "../../../lib/settings.ts"
import { environmentOf, useSettingsEnvironment } from "../../../lib/environments.ts"
import { m } from "../../../paraglide/messages.js"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../ui/alert-dialog.tsx"
import { Badge } from "../../ui/badge.tsx"
import { Button } from "../../ui/button.tsx"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../../ui/field.tsx"
import { Input } from "../../ui/input.tsx"
import { Switch } from "../../ui/switch.tsx"
import { BindHostSelect, LOOPBACK } from "../BindHostSelect.tsx"
import { SettingsPageAction, SettingsSection, settingsSurfaceClass } from "../SettingsSection.tsx"
import { AutomationDetails, WebhookUrlField } from "./AutomationDetails.tsx"
import { AutomationDialog, type AutomationDialogState } from "./AutomationForm.tsx"
import { CopyField, formatTime, RunStatusBadge, triggerLabel } from "./shared.tsx"
import { SkeletonList } from "../../ui/skeleton.tsx"
import { ChevronDownIcon } from "../../icons/ChevronDownIcon.tsx"
import { PencilIcon } from "../../icons/PencilIcon.tsx"
import { PlusIcon } from "../../icons/PlusIcon.tsx"
import { TrashIcon } from "../../icons/TrashIcon.tsx"

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function AutomationSettings() {
  const environment = useSettingsEnvironment()
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => []).filter(
    (project) => environmentOf(project) === environment,
  )
  const [dialog, setDialog] = useState<AutomationDialogState | null>(null)
  const [created, setCreated] = useState<{ automation: Automation; secret: string } | null>(null)

  return (
    <SettingsSection>
      <SettingsPageAction>
        <Button size="sm" onClick={() => setDialog({ mode: "create" })} disabled={projects.length === 0}>
          <PlusIcon aria-hidden />
          {m.automations_new()}
        </Button>
      </SettingsPageAction>
      <ListenerSettings />
      <AutomationList projects={projects} onEdit={(automation) => setDialog({ mode: "edit", automation })} />
      {dialog && (
        <AutomationDialog
          state={dialog}
          projects={projects}
          onClose={() => setDialog(null)}
          onCreated={(automation, secret) => {
            setDialog(null)
            if (secret !== null) setCreated({ automation, secret })
          }}
        />
      )}
      {created && <SecretDialog {...created} onClose={() => setCreated(null)} />}
    </SettingsSection>
  )
}

function ListenerSettings() {
  const environment = useSettingsEnvironment()
  const { automations: listener } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [port, setPort] = useState(String(listener.port))
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const save = (patch: Partial<typeof listener>) =>
    startTransition(async () => {
      setError(null)
      try {
        await updateSettings({ automations: { ...listener, ...patch } })
      } catch (cause) {
        setError(errorText(cause))
      }
    })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    save({ port: Number(port) })
  }

  return (
    <div className={cn(settingsSurfaceClass, "flex flex-col gap-3 p-4")}>
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64">
          <FieldLabel htmlFor="automation-bind-host">{m.automations_bind_label()}</FieldLabel>
          <BindHostSelect
            id="automation-bind-host"
            environment={environment}
            value={listener.bindHost}
            onChange={(bindHost) => save({ bindHost })}
          />
        </Field>
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <Field className="w-28">
            <FieldLabel htmlFor="automation-port">{m.automations_port_label()}</FieldLabel>
            <Input
              id="automation-port"
              type="number"
              min={1}
              max={65535}
              required
              value={port}
              onChange={(event) => setPort(event.target.value)}
              className="font-mono tabular-nums"
            />
          </Field>
          <Button type="submit" variant="outline" disabled={pending || Number(port) === listener.port}>
            {m.settings_save()}
          </Button>
        </form>
      </div>
      <FieldDescription>
        {listener.bindHost === LOOPBACK
          ? m.automations_bind_loopback_hint()
          : m.automations_bind_address_hint({ address: listener.bindHost })}
      </FieldDescription>
      {error && <FieldError>{errorMessage(error)}</FieldError>}
    </div>
  )
}

interface AutomationListProps {
  readonly projects: ReadonlyArray<Project>
  readonly onEdit: (automation: Automation) => void
}

function AutomationList({ projects, onEdit }: AutomationListProps) {
  const environment = useSettingsEnvironment()
  const automations = useAtomValue(automationsAtom(environment))
  const refresh = useAtomRefresh(automationsAtom(environment))

  return AsyncResult.builder(automations)
    .onInitial(() => (
      <SkeletonList label={m.automations_loading()} rows={2} rowClassName="h-24 rounded-lg" className="gap-3" />
    ))
    .onSuccess((list) =>
      list.length === 0 ? (
        <div className={cn(settingsSurfaceClass, "flex flex-col items-center gap-1 px-6 py-10 text-center")}>
          <p className="text-sm font-medium">{m.automations_empty_title()}</p>
          <p className="text-sm text-pretty text-muted-foreground">
            {projects.length === 0 ? m.automations_empty_no_project() : m.automations_empty_hint()}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((automation) => (
            <AutomationItem
              key={automation.id}
              automation={automation}
              projectName={projects.find((project) => project.id === automation.projectId)?.name ?? ""}
              onEdit={() => onEdit(automation)}
            />
          ))}
        </ul>
      ),
    )
    .onError((cause) => (
      <div className="flex items-center gap-2">
        <p className="text-sm text-destructive">{m.automations_load_failed({ message: cause.message })}</p>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {m.common_retry()}
        </Button>
      </div>
    ))
    .orElse(() => null)
}

interface AutomationItemProps {
  readonly automation: Automation
  readonly projectName: string
  readonly onEdit: () => void
}

function AutomationItem({ automation, projectName, onEdit }: AutomationItemProps) {
  const environment = useSettingsEnvironment()
  const refreshList = useAtomRefresh(automationsAtom(environment))
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const detailsId = `automation-details-${automation.id}`
  const polling = automation.trigger.type !== "webhook"

  const run = (action: () => Promise<unknown>) =>
    startTransition(async () => {
      setError(null)
      try {
        await action()
        refreshList()
      } catch (cause) {
        setError(errorText(cause))
      }
    })

  return (
    <li className={cn(settingsSurfaceClass, "flex flex-col gap-3 p-4")}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium" title={automation.name}>
              {automation.name}
            </h3>
            <Badge variant="outline">{triggerLabel[automation.trigger.type]()}</Badge>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {projectName && <span>{projectName}</span>}
            {automation.lastRun ? (
              <span className="flex items-center gap-1.5">
                <RunStatusBadge status={automation.lastRun.status} />
                <time dateTime={automation.lastRun.createdAt} className="tabular-nums">
                  {formatTime(automation.lastRun.createdAt)}
                </time>
              </span>
            ) : (
              <span>{m.automations_never_run()}</span>
            )}
            {polling && automation.enabled && (
              <span className="tabular-nums">
                {automation.polledAt
                  ? m.automations_polled_at({ time: formatTime(automation.polledAt) })
                  : m.automations_poll_pending()}
              </span>
            )}
          </p>
        </div>
        <Switch
          aria-label={m.automations_enable_for({ name: automation.name })}
          checked={automation.enabled}
          disabled={pending}
          onCheckedChange={(enabled) => run(() => callPromise("automations.update", { id: automation.id, enabled }))}
        />
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "transition-transform duration-200 ease-out motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
          {m.automations_details()}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <PencilIcon aria-hidden />
          {m.automations_edit()}
        </Button>
        <DeleteAutomation
          name={automation.name}
          pending={pending}
          onConfirm={() => run(() => callPromise("automations.delete", { id: automation.id }))}
        />
      </div>
      {error && <FieldError>{errorMessage(error)}</FieldError>}
      {expanded && (
        <div id={detailsId}>
          <AutomationDetails automation={automation} />
        </div>
      )}
    </li>
  )
}

interface DeleteAutomationProps {
  readonly name: string
  readonly pending: boolean
  readonly onConfirm: () => void
}

function DeleteAutomation({ name, pending, onConfirm }: DeleteAutomationProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>
        <TrashIcon aria-hidden />
        {m.automations_delete()}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.automations_delete_title({ name })}</AlertDialogTitle>
          <AlertDialogDescription>{m.automations_delete_description()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
            {m.automations_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface SecretDialogProps {
  readonly automation: Automation
  readonly secret: string
  readonly onClose: () => void
}

function SecretDialog({ automation, secret, onClose }: SecretDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.automations_secret_title({ name: automation.name })}</DialogTitle>
          <DialogDescription>{m.automations_secret_description()}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-5">
          <WebhookUrlField automationId={automation.id} />
          <Field>
            <FieldLabel htmlFor="automation-secret">{m.automations_secret_label()}</FieldLabel>
            <CopyField id="automation-secret" value={secret} copyLabel={m.automations_copy_secret()} />
            <FieldDescription>{m.automations_secret_hint()}</FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{m.automations_secret_done()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
