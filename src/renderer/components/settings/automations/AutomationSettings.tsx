import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState, useTransition } from "react"
import { RiAddLine, RiArrowDownSLine, RiDeleteBinLine, RiPencilLine } from "react-icons/ri"
import type { Automation, Project } from "../../../../shared/domain.ts"
import { automationsAtom, callPromise, projectsAtom, updateSettingsAtom } from "../../../lib/rpc.ts"
import { useSettings } from "../../../lib/settings.ts"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select.tsx"
import { Switch } from "../../ui/switch.tsx"
import { SettingsSection } from "../SettingsSection.tsx"
import { AutomationDetails, WebhookUrlField } from "./AutomationDetails.tsx"
import { AutomationDialog, type AutomationDialogState } from "./AutomationForm.tsx"
import { CopyField, formatTime, RunStatusBadge, triggerLabel } from "./shared.tsx"

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function AutomationSettings() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const [dialog, setDialog] = useState<AutomationDialogState | null>(null)
  const [created, setCreated] = useState<{ automation: Automation; secret: string } | null>(null)

  return (
    <SettingsSection
      title={m.settings_automations()}
      description={m.automations_description()}
      action={
        <Button onClick={() => setDialog({ mode: "create" })} disabled={projects.length === 0}>
          <RiAddLine aria-hidden />
          {m.automations_new()}
        </Button>
      }
    >
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

const LOOPBACK = "127.0.0.1"
const ALL_INTERFACES = "0.0.0.0"

function ListenerSettings() {
  const { automations: listener } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [port, setPort] = useState(String(listener.port))
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const hostItems = [
    { value: LOOPBACK, label: m.automations_bind_loopback() },
    { value: ALL_INTERFACES, label: m.automations_bind_all() },
  ]

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
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64">
          <FieldLabel htmlFor="automation-bind-host">{m.automations_bind_label()}</FieldLabel>
          <Select
            items={hostItems}
            value={listener.bindHost}
            onValueChange={(next) => typeof next === "string" && save({ bindHost: next })}
          >
            <SelectTrigger id="automation-bind-host" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hostItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        {listener.bindHost === ALL_INTERFACES ? m.automations_bind_all_hint() : m.automations_bind_loopback_hint()}
      </FieldDescription>
      {error && <FieldError>{m.common_error({ message: error })}</FieldError>}
    </div>
  )
}

interface AutomationListProps {
  readonly projects: ReadonlyArray<Project>
  readonly onEdit: (automation: Automation) => void
}

function AutomationList({ projects, onEdit }: AutomationListProps) {
  const automations = useAtomValue(automationsAtom)
  const refresh = useAtomRefresh(automationsAtom)

  return AsyncResult.builder(automations)
    .onInitial(() => <p className="text-sm text-muted-foreground">{m.automations_loading()}</p>)
    .onSuccess((list) =>
      list.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-6 py-10 text-center">
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
  const refreshList = useAtomRefresh(automationsAtom)
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
    <li className="flex flex-col gap-3 rounded-lg border border-border p-4">
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
                <time dateTime={automation.lastRun.createdAt}>{formatTime(automation.lastRun.createdAt)}</time>
              </span>
            ) : (
              <span>{m.automations_never_run()}</span>
            )}
            {polling && automation.enabled && (
              <span>
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
          <RiArrowDownSLine
            aria-hidden
            className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
          />
          {m.automations_details()}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <RiPencilLine aria-hidden />
          {m.automations_edit()}
        </Button>
        <DeleteAutomation
          name={automation.name}
          pending={pending}
          onConfirm={() => run(() => callPromise("automations.delete", { id: automation.id }))}
        />
      </div>
      {error && <FieldError>{m.common_error({ message: error })}</FieldError>}
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
        <RiDeleteBinLine aria-hidden />
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

/** Shown once after creating a webhook automation; the secret cannot be read back later. */
function SecretDialog({ automation, secret, onClose }: SecretDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.automations_secret_title({ name: automation.name })}</DialogTitle>
          <DialogDescription>{m.automations_secret_description()}</DialogDescription>
        </DialogHeader>
        {/* min-w-0 lets the long URL and secret truncate instead of widening the dialog grid. */}
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
