import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, startTransition, useState, useTransition } from "react"
import type { Project, Routine, RoutineSchedule } from "../../../../shared/domain.ts"
import {
  type Cloud,
  environmentName,
  environmentOf,
  useClouds,
  useSettingsEnvironment,
} from "../../../lib/environments.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { callPromise, type EnvironmentId, projectsAtom, routinesAtom, updateSettingsAtom } from "../../../lib/rpc.ts"
import { useSettings } from "../../../lib/settings.ts"
import { m } from "../../../paraglide/messages.js"
import { getLocale } from "../../../paraglide/runtime.js"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog.tsx"
import { Button } from "../../ui/button.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu.tsx"
import { Field, FieldError, FieldLabel } from "../../ui/field.tsx"
import { Input } from "../../ui/input.tsx"
import { SkeletonList } from "../../ui/skeleton.tsx"
import { Switch } from "../../ui/switch.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx"
import { BindHostSelect } from "../BindHostSelect.tsx"
import { settingsGroupClass, SettingsPageAction, SettingsSection, settingsSurfaceClass } from "../SettingsSection.tsx"
import { RoutineDetails } from "./RoutineDetails.tsx"
import { RoutineDialog, type RoutineDialogState } from "./RoutineForm.tsx"
import { describeCron } from "./schedule.ts"

const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

const scheduleLabel = ({ cron, timezone }: RoutineSchedule) => {
  const label = describeCron(cron, getLocale())
  return timezone === localTimezone ? label : `${label} (${timezone})`
}
import { formatTime, RunStatusBadge } from "./shared.tsx"
import { ChevronDownIcon, MoreIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from "@hinacode/icons"

const noProjects: ReadonlyArray<Project> = []

export function RoutineSettings() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => noProjects)
  const [dialog, setDialog] = useState<RoutineDialogState | null>(null)

  return (
    <SettingsSection>
      <SettingsPageAction>
        <Button
          size="sm"
          onClick={() => startTransition(() => setDialog({ mode: "create" }))}
          disabled={projects.length === 0}
        >
          <PlusIcon aria-hidden />
          {m.routines_new()}
        </Button>
      </SettingsPageAction>
      <RoutineList
        projects={projects}
        onEdit={(routine) => startTransition(() => setDialog({ mode: "edit", routine }))}
      />
      <ListenerSettings />
      {dialog && (
        <RoutineDialog state={dialog} projects={projects} onClose={() => startTransition(() => setDialog(null))} />
      )}
    </SettingsSection>
  )
}

function ListenerSettings() {
  const environment = useSettingsEnvironment()
  const { routines: listener } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [port, setPort] = useState(String(listener.port))
  const [error, setError] = useState<string | null>(null)
  const [pending, startSaving] = useTransition()

  const save = (patch: Partial<typeof listener>) =>
    startSaving(async () => {
      setError(null)
      try {
        await updateSettings({ routines: patch })
      } catch (cause) {
        setError(errorMessage(cause))
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
          <FieldLabel htmlFor="routine-bind-host">{m.routines_bind_label()}</FieldLabel>
          <BindHostSelect
            id="routine-bind-host"
            environment={environment}
            value={listener.bindHost}
            onChange={(bindHost) => save({ bindHost })}
          />
        </Field>
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <Field className="w-28">
            <FieldLabel htmlFor="routine-port">{m.routines_port_label()}</FieldLabel>
            <Input
              id="routine-port"
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
      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}

interface MachineGroup {
  readonly environment: EnvironmentId
  readonly routines: ReadonlyArray<Routine>
}

const groupByMachine = (
  routines: ReadonlyArray<Routine>,
  projects: ReadonlyArray<Project>,
  clouds: ReadonlyArray<Cloud>,
): ReadonlyArray<MachineGroup> => {
  const machineOf = (routine: Routine) => environmentOf(projects.find((project) => project.id === routine.projectId))
  const machines = [...new Set<EnvironmentId>([null, ...clouds.map((cloud) => cloud.id), ...routines.map(machineOf)])]
  return machines
    .map((environment) => ({ environment, routines: routines.filter((routine) => machineOf(routine) === environment) }))
    .filter((group) => group.routines.length > 0)
}

interface RoutineListProps {
  readonly projects: ReadonlyArray<Project>
  readonly onEdit: (routine: Routine) => void
}

function RoutineList({ projects, onEdit }: RoutineListProps) {
  const routines = useAtomValue(routinesAtom)
  const refresh = useAtomRefresh(routinesAtom)
  const clouds = useClouds()

  return AsyncResult.builder(routines)
    .onInitial(() => <SkeletonList label={m.routines_loading()} rows={2} rowClassName="h-14 rounded-lg" />)
    .onSuccess((list) => {
      if (list.length === 0) {
        return (
          <div className={cn(settingsSurfaceClass, "px-6 py-10 text-center text-sm text-muted-foreground")}>
            {projects.length === 0 ? m.routines_empty_no_project() : m.routines_empty()}
          </div>
        )
      }
      const groups = groupByMachine(list, projects, clouds)
      return (
        <div className="flex flex-col gap-6">
          {groups.map(({ environment, routines: group }) => {
            const machine = environmentName(environment, clouds)
            return (
              <section key={environment ?? ""} aria-label={machine} className="flex flex-col gap-4">
                {groups.length > 1 && <h3 className="-mb-2 px-1 text-sm font-medium">{machine}</h3>}
                <ul className={settingsGroupClass}>
                  {group.map((routine) => (
                    <RoutineRow
                      key={routine.id}
                      routine={routine}
                      environment={environment}
                      machine={machine}
                      projectName={projects.find((project) => project.id === routine.projectId)?.name ?? ""}
                      onEdit={() => onEdit(routine)}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )
    })
    .onError((cause) => (
      <div className="flex items-center gap-2">
        <p className="text-sm text-destructive">{m.routines_load_failed({ message: errorMessage(cause) })}</p>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {m.common_retry()}
        </Button>
      </div>
    ))
    .orElse(() => null)
}

interface RoutineRowProps {
  readonly routine: Routine
  readonly environment: EnvironmentId
  readonly machine: string
  readonly projectName: string
  readonly onEdit: () => void
}

function RoutineRow({ routine, environment, machine, projectName, onEdit }: RoutineRowProps) {
  const refreshList = useAtomRefresh(routinesAtom)
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [queued, setQueued] = useState<"edit" | "delete" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startUpdate] = useTransition()
  const detailsId = `routine-details-${routine.id}`
  const { lastRun } = routine

  const run = (action: () => Promise<unknown>) =>
    startUpdate(async () => {
      setError(null)
      try {
        await action()
        refreshList()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  const runNow = async () => {
    setError(null)
    try {
      await callPromise("routines.run", { id: routine.id })
      refreshList()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => startTransition(() => setExpanded((open) => !open))}
          className="group/row flex min-w-0 flex-1 items-start gap-2 rounded-md text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
              !expanded && "-rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={cn("truncate text-sm font-medium", !routine.enabled && "text-muted-foreground")}>
              {routine.name}
            </span>
            <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {projectName && <span className="truncate">{projectName}</span>}
              <span>{routine.schedule ? scheduleLabel(routine.schedule) : m.routines_no_schedule()}</span>
              {routine.nextRunAt && (
                <span className="tabular-nums">{m.routines_next_run({ time: formatTime(routine.nextRunAt) })}</span>
              )}
            </span>
          </span>
        </button>
        {lastRun &&
          (lastRun.threadId === null ? (
            <span title={formatTime(lastRun.createdAt)}>
              <RunStatusBadge status={lastRun.status} />
            </span>
          ) : (
            <Link
              to="/thread/$threadId"
              params={{ threadId: lastRun.threadId }}
              title={m.routines_last_run({ time: formatTime(lastRun.createdAt) })}
              className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <RunStatusBadge status={lastRun.status} />
            </Link>
          ))}
        <Switch
          aria-label={m.routines_enable_for({ name: routine.name })}
          checked={routine.enabled}
          disabled={pending}
          onCheckedChange={(enabled) => run(() => callPromise("routines.update", { id: routine.id, enabled }))}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={m.routines_run_now_for({ name: routine.name })}
                action={runNow}
              />
            }
          >
            <PlayIcon aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{m.routines_run_now()}</TooltipContent>
        </Tooltip>
        <DropdownMenu
          onOpenChangeComplete={(open) => {
            if (open || queued === null) return
            setQueued(null)
            if (queued === "edit") onEdit()
            else setConfirmDelete(true)
          }}
        >
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={m.routines_actions({ name: routine.name })} />}
          >
            <MoreIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => setQueued("edit")}>
              <PencilIcon aria-hidden />
              {m.routines_edit()}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setQueued("delete")}>
              <TrashIcon aria-hidden />
              {m.routines_delete()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && <FieldError>{error}</FieldError>}
      {expanded && (
        <div id={detailsId} className="ps-6">
          <RoutineDetails routine={routine} environment={environment} machine={machine} />
        </div>
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.routines_delete_title({ name: routine.name })}</AlertDialogTitle>
            <AlertDialogDescription>{m.routines_delete_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => callPromise("routines.delete", { id: routine.id }))}
            >
              {m.routines_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
