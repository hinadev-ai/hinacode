import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, lazy, startTransition, Suspense, useActionState, useState } from "react"
import { type AgentCommand, ProviderId } from "../../../../shared/agent.ts"
import {
  enabledProviders,
  isCronExpression,
  type Project,
  type Routine,
  type RoutineWorkspace,
  startingProvider,
} from "../../../../shared/domain.ts"
import { type Cloud, environmentName, environmentOf, useClouds } from "../../../lib/environments.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { type EnvironmentId, modelsAtom, projectCommandsAtom, routinesAtom, callPromise } from "../../../lib/rpc.ts"
import { useInstalledProviders, useSettings } from "../../../lib/settings.ts"
import { m } from "../../../paraglide/messages.js"
import { effortLabel } from "../../ComposerControls.tsx"
import { ProviderIcon, providerLabel } from "../../ProviderIcon.tsx"
import { Button } from "../../ui/button.tsx"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.tsx"
import { Field, FieldError, FieldGroup, FieldLabel } from "../../ui/field.tsx"
import { Input } from "../../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select.tsx"
import { Switch } from "../../ui/switch.tsx"
import { defaultScheduleDraft, fromCron, type ScheduleDraft, toCron } from "./schedule.ts"
import { SchedulePicker } from "./SchedulePicker.tsx"
import { localTimeZone } from "./shared.tsx"

const ComposerInput = lazy(() =>
  import("../../ComposerInput.tsx").then((module) => ({ default: module.ComposerInput })),
)

const DEFAULT_EFFORT = "default"
const noCommands: ReadonlyArray<AgentCommand> = []
const noThreads = { sameMachine: [], otherMachines: [] }
const isProviderId = (value: unknown): value is ProviderId => ProviderId.literals.some((id) => id === value)

interface Draft {
  readonly name: string
  readonly projectId: string
  readonly schedule: ScheduleDraft
  readonly prompt: string
  readonly provider: ProviderId | null
  readonly model: string
  readonly effort: string | null
  readonly workspace: RoutineWorkspace
  readonly enabled: boolean
}

const emptyDraft = (projectId: string): Draft => ({
  name: "",
  projectId,
  schedule: defaultScheduleDraft,
  prompt: "",
  provider: null,
  model: "",
  effort: null,
  workspace: "local",
  enabled: true,
})

const draftFrom = (routine: Routine): Draft => ({
  name: routine.name,
  projectId: routine.projectId,
  schedule: fromCron(routine.schedule?.cron ?? null),
  prompt: routine.prompt,
  provider: routine.provider,
  model: routine.model,
  effort: routine.effort,
  workspace: routine.workspace,
  enabled: routine.enabled,
})

export type RoutineDialogState = { readonly mode: "create" } | { readonly mode: "edit"; readonly routine: Routine }

interface RoutineDialogProps {
  readonly state: RoutineDialogState
  readonly projects: ReadonlyArray<Project>
  readonly onClose: () => void
}

export function RoutineDialog({ state, projects, onClose }: RoutineDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {state.mode === "create" ? m.routines_dialog_create_title() : m.routines_dialog_edit_title()}
          </DialogTitle>
        </DialogHeader>
        <RoutineForm state={state} projects={projects} onDone={onClose} />
      </DialogContent>
    </Dialog>
  )
}

const projectLabel = (project: Project, clouds: ReadonlyArray<Cloud>, manyMachines: boolean) =>
  manyMachines
    ? m.routines_project_on_machine({
        project: project.name,
        machine: environmentName(environmentOf(project), clouds),
      })
    : project.name

interface RoutineFormProps {
  readonly state: RoutineDialogState
  readonly projects: ReadonlyArray<Project>
  readonly onDone: () => void
}

function RoutineForm({ state, projects, onDone }: RoutineFormProps) {
  const editing = state.mode === "edit"
  const clouds = useClouds()
  const refreshList = useAtomRefresh(routinesAtom)
  const [draft, setDraft] = useState<Draft>(() =>
    editing ? draftFrom(state.routine) : emptyDraft(projects[0]?.id ?? ""),
  )
  const [timezone] = useState(() => (editing ? state.routine.schedule?.timezone : undefined) ?? localTimeZone())
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }))

  const project = projects.find((candidate) => candidate.id === draft.projectId)
  const environment = environmentOf(project)
  const settings = useSettings(environment)
  const installed = useInstalledProviders(environment)
  const provider = draft.provider ?? startingProvider(settings, installed)
  const model = draft.model || (settings.defaultModel[provider] ?? "")
  const commandsResult = useAtomValue(projectCommandsAtom(draft.projectId, provider))
  const commands = AsyncResult.getOrElse(commandsResult, () => noCommands)
  const cron = toCron(draft.schedule)
  const invalidSchedule = cron !== null && !isCronExpression(cron, timezone)

  const [error, submit, isPending] = useActionState(async (_: string | null, input: Draft) => {
    if (input.prompt.trim() === "") return m.routines_prompt_required()
    const fields = {
      name: input.name.trim(),
      enabled: input.enabled,
      prompt: input.prompt,
      provider,
      model: model.trim(),
      effort: input.effort,
      workspace: input.workspace,
      schedule: cron === null ? null : { cron, timezone },
    }
    try {
      if (editing) await callPromise("routines.update", { id: state.routine.id, ...fields })
      else await callPromise("routines.create", { projectId: input.projectId, ...fields })
      refreshList()
      onDone()
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startTransition(() => submit(draft))
  }

  const manyMachines = new Set(projects.map(environmentOf)).size > 1
  const projectItems = projects.map((candidate) => ({
    value: candidate.id,
    label: projectLabel(candidate, clouds, manyMachines),
  }))
  const changeProject = (projectId: string) => {
    const next = projects.find((candidate) => candidate.id === projectId)
    patch(environmentOf(next) === environment ? { projectId } : { projectId, provider: null, model: "", effort: null })
  }

  return (
    <form onSubmit={onSubmit} className="@container flex flex-col gap-4">
      <FieldGroup>
        <div className="grid gap-3 @md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="routine-name">{m.routines_name_label()}</FieldLabel>
            <Input
              id="routine-name"
              required
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder={m.routines_name_placeholder()}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="routine-project">{m.routines_project_label()}</FieldLabel>
            <Select
              items={projectItems}
              value={draft.projectId}
              disabled={editing}
              onValueChange={(next) => typeof next === "string" && changeProject(next)}
            >
              <SelectTrigger id="routine-project" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projectItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <SchedulePicker value={draft.schedule} timezone={timezone} onChange={(schedule) => patch({ schedule })} />
        <Field>
          <FieldLabel>{m.routines_prompt_label()}</FieldLabel>
          <div className="relative rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30 [&_.cm-content]:min-h-24">
            <Suspense fallback={<div className="min-h-24" />}>
              <ComposerInput
                aria-label={m.routines_prompt_label()}
                placeholder={m.routines_prompt_placeholder()}
                value={draft.prompt}
                onValueChange={(prompt) => patch({ prompt })}
                commands={commands}
                files={[]}
                onMentionStart={() => {}}
                threads={noThreads}
                terminals={[]}
                artifacts={[]}
                projectId={draft.projectId}
              />
            </Suspense>
          </div>
        </Field>
        <AgentFields
          environment={environment}
          providers={enabledProviders(settings, installed)}
          provider={provider}
          model={model}
          effort={draft.effort}
          onChange={patch}
        />
        <Field orientation="horizontal">
          <FieldLabel htmlFor="routine-worktree">{m.thread_worktree_label()}</FieldLabel>
          <Switch
            id="routine-worktree"
            checked={draft.workspace === "worktree"}
            onCheckedChange={(worktree) => patch({ workspace: worktree ? "worktree" : "local" })}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="routine-enabled">{m.routines_enabled_label()}</FieldLabel>
          <Switch id="routine-enabled" checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
        </Field>
      </FieldGroup>
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={isPending || invalidSchedule || project === undefined}>
          {editing ? m.settings_save() : m.routines_create()}
        </Button>
      </DialogFooter>
    </form>
  )
}

interface AgentFieldsProps {
  readonly environment: EnvironmentId
  readonly providers: ReadonlyArray<ProviderId>
  readonly provider: ProviderId
  readonly model: string
  readonly effort: string | null
  readonly onChange: (next: Partial<Pick<Draft, "provider" | "model" | "effort">>) => void
}

function AgentFields({ environment, providers, provider, model, effort, onChange }: AgentFieldsProps) {
  const models = useAtomValue(modelsAtom(environment, provider))
  const listed = AsyncResult.getOrElse(models, () => [])
  const current = listed.find((candidate) => candidate.id === model)
  const providerItems = (providers.includes(provider) ? providers : [provider, ...providers]).map((id) => ({
    value: id,
    label: providerLabel[id](),
  }))
  const modelItems = listed.map((candidate) => ({ value: candidate.id, label: candidate.label }))
  if (model !== "" && current === undefined) modelItems.push({ value: model, label: model })
  const efforts = current?.efforts ?? []
  const effortItems = [
    {
      value: DEFAULT_EFFORT,
      label: current?.defaultEffort
        ? m.thread_effort_default_named({ effort: effortLabel(current.defaultEffort) })
        : m.thread_effort_default(),
    },
    ...efforts.map((value) => ({ value, label: effortLabel(value) })),
  ]
  const pickModel = (next: string) => {
    const supported = listed.find((candidate) => candidate.id === next)?.efforts ?? []
    onChange({ model: next, ...(effort !== null && !supported.includes(effort) ? { effort: null } : {}) })
  }

  return (
    <div className="grid gap-3 @md:grid-cols-3">
      <Field>
        <FieldLabel htmlFor="routine-provider">{m.thread_provider_label()}</FieldLabel>
        <Select
          items={providerItems}
          value={provider}
          onValueChange={(next) => isProviderId(next) && onChange({ provider: next, model: "", effort: null })}
        >
          <SelectTrigger id="routine-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <ProviderIcon provider={item.value} />
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="routine-model">{m.thread_model_label()}</FieldLabel>
        {listed.length > 0 ? (
          <Select
            items={modelItems}
            value={model}
            onValueChange={(next) => typeof next === "string" && pickModel(next)}
          >
            <SelectTrigger id="routine-model" className="w-full">
              <SelectValue placeholder={m.settings_models_pick()} />
            </SelectTrigger>
            <SelectContent>
              {modelItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id="routine-model"
            required
            value={model}
            onChange={(event) => onChange({ model: event.target.value })}
            placeholder={AsyncResult.isInitial(models) ? m.settings_models_loading() : m.thread_model_placeholder()}
            spellCheck={false}
            className="font-mono"
          />
        )}
      </Field>
      {efforts.length > 0 && (
        <Field>
          <FieldLabel htmlFor="routine-effort">{m.thread_effort_picker()}</FieldLabel>
          <Select
            items={effortItems}
            value={effort ?? DEFAULT_EFFORT}
            onValueChange={(next) =>
              typeof next === "string" && onChange({ effort: next === DEFAULT_EFFORT ? null : next })
            }
          >
            <SelectTrigger id="routine-effort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {effortItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    </div>
  )
}
