import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, startTransition, useActionState, useState } from "react"
import { ProviderId } from "../../../../shared/agent.ts"
import type { Automation, AutomationTrigger, AutomationTriggerType, Project } from "../../../../shared/domain.ts"
import { callPromise, modelsAtom } from "../../../lib/rpc.ts"
import { useSettings } from "../../../lib/settings.ts"
import { m } from "../../../paraglide/messages.js"
import { ProviderIcon } from "../../ProviderIcon.tsx"
import { Button } from "../../ui/button.tsx"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../../ui/field.tsx"
import { Input } from "../../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select.tsx"
import { Switch } from "../../ui/switch.tsx"
import { Textarea } from "../../ui/textarea.tsx"
import { triggerLabel } from "./shared.tsx"

const providerLabel = { claude: m.provider_claude, codex: m.provider_codex } satisfies Record<ProviderId, () => string>
const triggerTypes: ReadonlyArray<AutomationTriggerType> = ["webhook", "github.issue", "linear.issue", "slack.mention"]
const isProviderId = (value: unknown): value is ProviderId => ProviderId.literals.some((id) => id === value)
const isTriggerType = (value: unknown): value is AutomationTriggerType => triggerTypes.some((type) => type === value)

/** Placeholders each trigger's payload offers, shown under the prompt template. */
const placeholderHints = {
  webhook: ["{{body.*}}", "{{headers.*}}"],
  "github.issue": ["{{issue.title}}", "{{issue.body}}", "{{issue.url}}", "{{issue.number}}", "{{issue.author}}"],
  "linear.issue": ["{{issue.identifier}}", "{{issue.title}}", "{{issue.body}}", "{{issue.url}}"],
  "slack.mention": ["{{message.text}}", "{{message.permalink}}", "{{message.channel}}", "{{message.user}}"],
} satisfies Record<AutomationTriggerType, ReadonlyArray<string>>

/** Every field of every trigger, flat, so switching trigger type keeps what was typed. */
interface Draft {
  readonly name: string
  readonly projectId: string
  readonly enabled: boolean
  readonly triggerType: AutomationTriggerType
  readonly repo: string
  readonly labels: string
  readonly teamKey: string
  readonly stateName: string
  readonly label: string
  readonly channel: string
  readonly botUserId: string
  readonly promptTemplate: string
  readonly provider: ProviderId
  readonly model: string
  readonly runInWorktree: boolean
  readonly branchTemplate: string
}

const emptyDraft = (projectId: string, model: string): Draft => ({
  name: "",
  projectId,
  enabled: true,
  triggerType: "webhook",
  repo: "",
  labels: "",
  teamKey: "",
  stateName: "",
  label: "",
  channel: "",
  botUserId: "",
  promptTemplate: "",
  provider: "claude",
  model,
  runInWorktree: false,
  branchTemplate: "",
})

const draftFrom = (automation: Automation): Draft => {
  const { trigger } = automation
  return {
    ...emptyDraft(automation.projectId, automation.model),
    name: automation.name,
    enabled: automation.enabled,
    triggerType: trigger.type,
    repo: trigger.type === "github.issue" ? trigger.repo : "",
    labels: trigger.type === "github.issue" ? (trigger.labels ?? []).join(", ") : "",
    teamKey: trigger.type === "linear.issue" ? trigger.teamKey : "",
    stateName: trigger.type === "linear.issue" ? (trigger.stateName ?? "") : "",
    label: trigger.type === "linear.issue" ? (trigger.label ?? "") : "",
    channel: trigger.type === "slack.mention" ? (trigger.channel ?? "") : "",
    botUserId: trigger.type === "slack.mention" ? trigger.botUserId : "",
    promptTemplate: automation.promptTemplate,
    provider: automation.provider,
    runInWorktree: automation.runInWorktree,
    branchTemplate: automation.branchTemplate ?? "",
  }
}

const triggerFrom = (draft: Draft): AutomationTrigger => {
  switch (draft.triggerType) {
    case "webhook":
      return { type: "webhook" }
    case "github.issue": {
      const labels = draft.labels
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label !== "")
      return { type: "github.issue", repo: draft.repo.trim(), ...(labels.length > 0 ? { labels } : {}) }
    }
    case "linear.issue":
      return {
        type: "linear.issue",
        teamKey: draft.teamKey.trim(),
        ...(draft.stateName.trim() === "" ? {} : { stateName: draft.stateName.trim() }),
        ...(draft.label.trim() === "" ? {} : { label: draft.label.trim() }),
      }
    case "slack.mention":
      return {
        type: "slack.mention",
        botUserId: draft.botUserId.trim(),
        ...(draft.channel.trim() === "" ? {} : { channel: draft.channel.trim() }),
      }
  }
}

export type AutomationDialogState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly automation: Automation }

interface AutomationDialogProps {
  readonly state: AutomationDialogState
  readonly projects: ReadonlyArray<Project>
  readonly onClose: () => void
  /** Called after a create; `secret` is the webhook secret, shown only once. */
  readonly onCreated: (automation: Automation, secret: string | null) => void
}

export function AutomationDialog({ state, projects, onClose, onCreated }: AutomationDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {state.mode === "create" ? m.automations_dialog_create_title() : m.automations_dialog_edit_title()}
          </DialogTitle>
          <DialogDescription>{m.automations_dialog_description()}</DialogDescription>
        </DialogHeader>
        <AutomationForm state={state} projects={projects} onDone={onClose} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  )
}

interface AutomationFormProps {
  readonly state: AutomationDialogState
  readonly projects: ReadonlyArray<Project>
  readonly onDone: () => void
  readonly onCreated: AutomationDialogProps["onCreated"]
}

function AutomationForm({ state, projects, onDone, onCreated }: AutomationFormProps) {
  const { defaultModel } = useSettings()
  const editing = state.mode === "edit"
  const [draft, setDraft] = useState<Draft>(() =>
    editing ? draftFrom(state.automation) : emptyDraft(projects[0]?.id ?? "", defaultModel.claude ?? ""),
  )
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }))

  const [error, submit, isPending] = useActionState(async (_: string | null, input: Draft) => {
    const fields = {
      name: input.name.trim(),
      enabled: input.enabled,
      trigger: triggerFrom(input),
      promptTemplate: input.promptTemplate,
      provider: input.provider,
      model: input.model.trim(),
      runInWorktree: input.runInWorktree,
      branchTemplate: input.runInWorktree && input.branchTemplate.trim() !== "" ? input.branchTemplate.trim() : null,
    }
    try {
      if (editing) {
        await callPromise("automations.update", { id: state.automation.id, ...fields })
        onDone()
      } else {
        const { automation, secret } = await callPromise("automations.create", {
          projectId: input.projectId,
          ...fields,
        })
        onCreated(automation, secret)
      }
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }, null)

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startTransition(() => submit(draft))
  }

  const projectItems = projects.map((project) => ({ value: project.id, label: project.name }))
  const triggerItems = triggerTypes.map((type) => ({ value: type, label: triggerLabel[type]() }))
  const providerItems = ProviderId.literals.map((id) => ({ value: id, label: providerLabel[id]() }))

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="automation-name">{m.automations_name_label()}</FieldLabel>
          <Input
            id="automation-name"
            required
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder={m.automations_name_placeholder()}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="automation-project">{m.automations_project_label()}</FieldLabel>
          <Select
            items={projectItems}
            value={draft.projectId}
            disabled={editing}
            onValueChange={(next) => typeof next === "string" && patch({ projectId: next })}
          >
            <SelectTrigger id="automation-project" className="w-full">
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
        <Field>
          <FieldLabel htmlFor="automation-trigger">{m.automations_trigger_label()}</FieldLabel>
          <Select
            items={triggerItems}
            value={draft.triggerType}
            disabled={editing}
            onValueChange={(next) => isTriggerType(next) && patch({ triggerType: next })}
          >
            <SelectTrigger id="automation-trigger" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {triggerItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {editing && <FieldDescription>{m.automations_trigger_fixed()}</FieldDescription>}
        </Field>
        <TriggerFields draft={draft} patch={patch} />
        <Field>
          <FieldLabel htmlFor="automation-prompt">{m.automations_prompt_label()}</FieldLabel>
          <Textarea
            id="automation-prompt"
            required
            value={draft.promptTemplate}
            onChange={(event) => patch({ promptTemplate: event.target.value })}
            placeholder={m.automations_prompt_placeholder({ example: placeholderHints[draft.triggerType][0] ?? "" })}
            spellCheck={false}
            className="min-h-24 font-mono"
          />
          <FieldDescription>
            {m.automations_prompt_hint()}{" "}
            {placeholderHints[draft.triggerType].map((hint) => (
              <code key={hint} className="mr-1.5 rounded bg-muted px-1 font-mono text-xs text-foreground">
                {hint}
              </code>
            ))}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="automation-provider">{m.thread_provider_label()}</FieldLabel>
          <Select
            items={providerItems}
            value={draft.provider}
            onValueChange={(next) => isProviderId(next) && patch({ provider: next, model: defaultModel[next] ?? "" })}
          >
            <SelectTrigger id="automation-provider" className="w-full">
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
        <ModelField provider={draft.provider} value={draft.model} onChange={(model) => patch({ model })} />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="automation-worktree">{m.thread_worktree_label()}</FieldLabel>
            <FieldDescription>{m.automations_worktree_hint()}</FieldDescription>
          </FieldContent>
          <Switch
            id="automation-worktree"
            checked={draft.runInWorktree}
            onCheckedChange={(runInWorktree) => patch({ runInWorktree })}
          />
        </Field>
        {draft.runInWorktree && (
          <Field>
            <FieldLabel htmlFor="automation-branch">{m.automations_branch_label()}</FieldLabel>
            <Input
              id="automation-branch"
              value={draft.branchTemplate}
              onChange={(event) => patch({ branchTemplate: event.target.value })}
              placeholder="kk/issue-{{issue.number}}"
              spellCheck={false}
              className="font-mono"
            />
            <FieldDescription>{m.automations_branch_hint()}</FieldDescription>
          </Field>
        )}
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="automation-enabled">{m.automations_enabled_label()}</FieldLabel>
            <FieldDescription>{m.automations_enabled_hint()}</FieldDescription>
          </FieldContent>
          <Switch id="automation-enabled" checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
        </Field>
      </FieldGroup>
      {error && <FieldError>{m.common_error({ message: error })}</FieldError>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={isPending}>
          {editing ? m.settings_save() : m.automations_create()}
        </Button>
      </DialogFooter>
    </form>
  )
}

interface TriggerFieldsProps {
  readonly draft: Draft
  readonly patch: (next: Partial<Draft>) => void
}

function TriggerFields({ draft, patch }: TriggerFieldsProps) {
  switch (draft.triggerType) {
    case "webhook":
      return <p className="text-sm text-muted-foreground">{m.automations_webhook_hint()}</p>
    case "github.issue":
      return (
        <>
          <TextField
            id="automation-repo"
            label={m.automations_repo_label()}
            value={draft.repo}
            onChange={(repo) => patch({ repo })}
            placeholder="pingdotgg/t3code"
            required
            hint={m.automations_repo_hint()}
          />
          <TextField
            id="automation-labels"
            label={m.automations_labels_label()}
            value={draft.labels}
            onChange={(labels) => patch({ labels })}
            placeholder="bug, agent"
            hint={m.automations_labels_hint()}
          />
        </>
      )
    case "linear.issue":
      return (
        <>
          <TextField
            id="automation-team"
            label={m.automations_team_label()}
            value={draft.teamKey}
            onChange={(teamKey) => patch({ teamKey })}
            placeholder="ENG"
            required
            hint={m.automations_linear_hint()}
          />
          <TextField
            id="automation-state"
            label={m.automations_state_label()}
            value={draft.stateName}
            onChange={(stateName) => patch({ stateName })}
            placeholder="Todo"
          />
          <TextField
            id="automation-label"
            label={m.automations_label_label()}
            value={draft.label}
            onChange={(label) => patch({ label })}
            placeholder="agent"
          />
        </>
      )
    case "slack.mention":
      return (
        <>
          <TextField
            id="automation-bot"
            label={m.automations_bot_label()}
            value={draft.botUserId}
            onChange={(botUserId) => patch({ botUserId })}
            placeholder="U0123ABCD"
            required
            hint={m.automations_slack_hint()}
          />
          <TextField
            id="automation-channel"
            label={m.automations_channel_label()}
            value={draft.channel}
            onChange={(channel) => patch({ channel })}
            placeholder="#dev"
          />
        </>
      )
  }
}

interface TextFieldProps {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly hint?: string
  readonly required?: boolean
}

function TextField({ id, label, value, onChange, placeholder, hint, required }: TextFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        spellCheck={false}
        autoComplete="off"
        className="font-mono"
      />
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  )
}

interface ModelFieldProps {
  readonly provider: ProviderId
  readonly value: string
  readonly onChange: (model: string) => void
}

/** A select of the provider's models, or a free-text model id when it cannot list them. */
function ModelField({ provider, value, onChange }: ModelFieldProps) {
  const models = useAtomValue(modelsAtom(provider))
  const listed = AsyncResult.getOrElse(models, () => [])
  const items = listed.map((model) => ({ value: model.id, label: model.label }))
  // A stored id the provider no longer lists stays selectable instead of vanishing.
  if (value !== "" && !items.some((item) => item.value === value)) items.push({ value, label: value })

  return (
    <Field>
      <FieldLabel htmlFor="automation-model">{m.thread_model_label()}</FieldLabel>
      {listed.length > 0 ? (
        <Select items={items} value={value} onValueChange={(next) => typeof next === "string" && onChange(next)}>
          <SelectTrigger id="automation-model" className="w-full">
            <SelectValue placeholder={m.settings_models_pick()} />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id="automation-model"
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={m.thread_model_placeholder()}
          spellCheck={false}
          className="font-mono"
        />
      )}
      {AsyncResult.isInitial(models) && <FieldDescription>{m.settings_models_loading()}</FieldDescription>}
    </Field>
  )
}
