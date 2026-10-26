import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useRef, useState, useTransition } from "react"
import { CLAUDE_EFFORT_LEVELS, type ModelInfo, ProviderId, unlistedModel } from "../../../shared/agent.ts"
import { AccessMode, AUTO_COMPACT_RANGE } from "../../../shared/domain.ts"
import { modelsAtom, updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { accessModes, effortLabel } from "../ComposerControls.tsx"
import { ProviderIcon, providerLabel } from "../ProviderIcon.tsx"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { AccountList, DefaultAccountField } from "./AccountSettings.tsx"
import { SettingsGroup, SettingsGroupTitle, SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"
import { SkeletonList } from "../ui/skeleton.tsx"

export function ModelSettings() {
  return (
    <SettingsSection title={m.settings_models()} description={m.settings_models_hint()}>
      {ProviderId.literals.map((provider) => (
        <ProviderModels key={provider} provider={provider} />
      ))}
      <SettingsGroup>
        <DefaultAccessField />
        <TextGenerationModelField />
        <PullRequestGuideField />
      </SettingsGroup>
    </SettingsSection>
  )
}

function ProviderModels({ provider }: { provider: ProviderId }) {
  const environment = useSettingsEnvironment()
  const models = useAtomValue(modelsAtom(environment, provider))
  const headingId = `provider-models-${provider}`
  return (
    <fieldset aria-labelledby={headingId} className="mt-4 flex min-w-0 flex-col gap-4">
      <SettingsGroupTitle id={headingId} className="flex items-center gap-2">
        <ProviderIcon provider={provider} />
        {providerLabel[provider]()}
      </SettingsGroupTitle>
      <SettingsGroup>
        <AccountList provider={provider} />
        <DefaultAccountField provider={provider} />
        <DefaultModelField provider={provider} />
        {AsyncResult.isSuccess(models) && models.value.length > 0 && (
          <ModelPresetField provider={provider} models={models.value} />
        )}
        <AutoCompactField provider={provider} />
      </SettingsGroup>
    </fieldset>
  )
}

function DefaultModelField({ provider }: { provider: ProviderId }) {
  const environment = useSettingsEnvironment()
  const models = useAtomValue(modelsAtom(environment, provider))
  const { defaultModel } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const current = defaultModel[provider]
  const inputId = `default-model-${provider}`
  const label = providerLabel[provider]()

  const save = async (model: string | null) => {
    setError(null)
    try {
      await updateSettings({ defaultModel: { ...defaultModel, [provider]: model } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const textFallback = (notice: string) => (
    <div className="flex flex-col gap-1.5">
      <ModelIdForm inputId={inputId} current={current} onSave={save} />
      <FieldDescription>{notice}</FieldDescription>
    </div>
  )

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={inputId}>{m.settings_default_model()}</FieldLabel>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      {AsyncResult.builder(models)
        .onInitial(() => (
          <SkeletonList label={m.settings_models_loading()} rows={1} rowClassName="h-8 w-72 rounded-lg" />
        ))
        .onSuccess((list) =>
          list.length > 0 ? (
            <ModelSelect inputId={inputId} models={list} current={current} onSave={save} />
          ) : (
            textFallback(m.settings_models_unlisted({ provider: label }))
          ),
        )
        .onError((cause) => textFallback(m.settings_models_failed({ provider: label, message: errorMessage(cause) })))
        .orElse(() => textFallback(m.settings_models_unlisted({ provider: label })))}
    </Field>
  )
}

/** Which of the agent's models the thread model picker lists. Picking none lists them all. */
function ModelPresetField({ provider, models }: { provider: ProviderId; models: ReadonlyArray<ModelInfo> }) {
  const environment = useSettingsEnvironment()
  const { modelPresets } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const inputId = `model-preset-${provider}`
  const items = models.map((model) => ({ value: model.id, label: model.label }))
  const listed = new Set(items.map((item) => item.value))
  const selected = modelPresets[provider].filter((id) => listed.has(id))

  const save = async (next: ReadonlyArray<string>) => {
    setError(null)
    try {
      await updateSettings({ modelPresets: { ...modelPresets, [provider]: next } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={inputId}>{m.settings_model_preset()}</FieldLabel>
        <FieldDescription>{m.settings_model_preset_hint()}</FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Select items={items} multiple value={selected} onValueChange={(next) => void save(next)}>
          <SelectTrigger id={inputId} className="w-72">
            <SelectValue className="min-w-0 truncate">
              {(value: ReadonlyArray<string>) =>
                value.length === 0
                  ? m.settings_model_preset_all()
                  : items
                      .filter((item) => value.includes(item.value))
                      .map((item) => item.label)
                      .join(", ")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void save([])}>
            {m.settings_model_preset_clear()}
          </Button>
        )}
      </div>
    </Field>
  )
}

/** The field is in thousands, like Claude Code's `/autocompact 500k`; the setting is in tokens. */
function AutoCompactField({ provider }: { provider: ProviderId }) {
  const environment = useSettingsEnvironment()
  const { autoCompactTokens } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const current = autoCompactTokens[provider]
  const [draft, setDraft] = useState(current === null ? "" : String(current / 1000))
  const inputId = `auto-compact-${provider}`
  const inputRef = useRef<HTMLInputElement>(null)
  const next = draft.trim() === "" ? null : Number(draft) * 1000

  const save = (tokens: number | null) =>
    startTransition(async () => {
      setError(null)
      try {
        await updateSettings({ autoCompactTokens: { ...autoCompactTokens, [provider]: tokens } })
        setDraft(tokens === null ? "" : String(tokens / 1000))
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    save(next)
  }

  // The clear button unmounts once the setting is null, which would leave keyboard focus on the page.
  const clear = () => {
    save(null)
    inputRef.current?.focus()
  }

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{m.settings_auto_compact()}</FieldLabel>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          type="number"
          inputMode="numeric"
          min={AUTO_COMPACT_RANGE.minimum / 1000}
          max={AUTO_COMPACT_RANGE.maximum / 1000}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={m.settings_auto_compact_default()}
          className="w-56 shrink-0 tabular-nums"
        />
        <span className="text-sm whitespace-nowrap text-muted-foreground">{m.settings_auto_compact_unit()}</span>
        <Button type="submit" variant="outline" disabled={next === current || pending}>
          {m.settings_save()}
        </Button>
        {current !== null && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={clear}>
            {m.settings_auto_compact_clear()}
          </Button>
        )}
      </form>
      <FieldDescription>{m.settings_auto_compact_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

function DefaultAccessField() {
  const environment = useSettingsEnvironment()
  const { defaultAccessMode } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const inputId = "default-access-mode"
  const items = AccessMode.literals.map((value) => ({ value, label: accessModes[value].label() }))
  const Icon = accessModes[defaultAccessMode].icon

  const save = async (next: AccessMode | null) => {
    if (next === null || next === defaultAccessMode) return
    setError(null)
    try {
      await updateSettings({ defaultAccessMode: next })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={inputId}>{m.settings_default_access()}</FieldLabel>
        <FieldDescription>{m.settings_default_access_hint()}</FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <div>
        <Select items={items} value={defaultAccessMode} onValueChange={(next) => void save(next)}>
          <SelectTrigger id={inputId} className="w-72">
            <Icon aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => {
              const ItemIcon = accessModes[item.value].icon
              return (
                <SelectItem key={item.value} value={item.value}>
                  <ItemIcon aria-hidden />
                  {item.label}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </div>
    </Field>
  )
}

/** Thread naming runs through the Claude Agent SDK, so only Claude models are offered. */
function TextGenerationModelField() {
  const environment = useSettingsEnvironment()
  const models = useAtomValue(modelsAtom(environment, "claude"))
  const { textGenerationModel } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const inputId = "text-generation-model"

  const save = async (model: string | null) => {
    if (model === null) return
    setError(null)
    try {
      await updateSettings({ textGenerationModel: model })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const listed = AsyncResult.getOrElse(models, (): ReadonlyArray<ModelInfo> => [])
  const items = listed.some((model) => model.id === textGenerationModel)
    ? listed
    : [unlistedModel(textGenerationModel, "claude"), ...listed]

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={inputId}>{m.settings_text_generation_model()}</FieldLabel>
        <FieldDescription>{m.settings_text_generation_model_hint()}</FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <ModelSelect inputId={inputId} models={items} current={textGenerationModel} onSave={save} clearable={false} />
    </Field>
  )
}

const GUIDE_EFFORTS = new Set(CLAUDE_EFFORT_LEVELS)

function PullRequestGuideField() {
  const environment = useSettingsEnvironment()
  const models = useAtomValue(modelsAtom(environment, "claude"))
  const { pullRequestGuide } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const inputId = "pull-request-guide-model"

  const listed = AsyncResult.getOrElse(models, (): ReadonlyArray<ModelInfo> => [])
  const items = listed.some((model) => model.id === pullRequestGuide.model)
    ? listed
    : [unlistedModel(pullRequestGuide.model, "claude"), ...listed]
  const effortsOf = (id: string) =>
    (items.find((model) => model.id === id)?.efforts ?? []).filter((effort) => GUIDE_EFFORTS.has(effort))
  const efforts = effortsOf(pullRequestGuide.model)
  const effortItems = [...new Set([...efforts, pullRequestGuide.effort])].map((value) => ({
    value,
    label: effortLabel(value),
  }))

  const save = async (next: typeof pullRequestGuide) => {
    setError(null)
    try {
      await updateSettings({ pullRequestGuide: next })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const effortKeptOrDefaultFor = (model: string) => {
    const available = effortsOf(model)
    if (available.length === 0 || available.includes(pullRequestGuide.effort)) return pullRequestGuide.effort
    return (
      items.find((candidate) => candidate.id === model)?.defaultEffort ?? available.at(-1) ?? pullRequestGuide.effort
    )
  }

  const saveModel = async (model: string | null) => {
    if (model === null) return
    await save({ model, effort: effortKeptOrDefaultFor(model) })
  }

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{m.settings_guide_model()}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <ModelSelect
          inputId={inputId}
          models={items}
          current={pullRequestGuide.model}
          onSave={saveModel}
          clearable={false}
        />
        <Select
          items={effortItems}
          value={pullRequestGuide.effort}
          onValueChange={(effort) => effort !== null && void save({ ...pullRequestGuide, effort })}
        >
          <SelectTrigger aria-label={m.thread_effort_picker()} className="w-40">
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
      </div>
      <FieldDescription>{m.settings_guide_model_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

interface ModelInputProps {
  readonly inputId: string
  readonly current: string | null
  readonly onSave: (model: string | null) => Promise<void>
}

function ModelSelect({
  inputId,
  models,
  current,
  onSave,
  clearable = true,
}: ModelInputProps & { models: ReadonlyArray<ModelInfo>; clearable?: boolean }) {
  const items = models.map((model) => ({ value: model.id, label: model.label }))
  return (
    <div className="flex items-center gap-2">
      <Select items={items} value={current} onValueChange={(next) => void onSave(next)}>
        <SelectTrigger id={inputId} className="w-72">
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
      {clearable && current !== null && (
        <Button variant="ghost" size="sm" onClick={() => void onSave(null)}>
          {m.settings_models_clear()}
        </Button>
      )}
    </div>
  )
}

/** Free-text model id, for providers that cannot list their models. */
function ModelIdForm({ inputId, current, onSave }: ModelInputProps) {
  const [draft, setDraft] = useState(current ?? "")
  const [pending, startTransition] = useTransition()
  const next = draft.trim()
  const dirty = next !== (current ?? "")

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startTransition(() => onSave(next === "" ? null : next))
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <Input
        id={inputId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={m.thread_model_placeholder()}
        spellCheck={false}
        autoComplete="off"
        className="w-72 font-mono"
      />
      <Button type="submit" variant="outline" disabled={!dirty || pending}>
        {m.settings_save()}
      </Button>
    </form>
  )
}
