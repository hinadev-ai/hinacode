import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  startTransition,
  useId,
  useRef,
  useState,
  useTransition,
} from "react"
import { CLAUDE_EFFORT_LEVELS, type ModelInfo, ProviderId, unlistedModel } from "../../../shared/agent.ts"
import { AccessMode, AUTO_COMPACT_RANGE } from "../../../shared/domain.ts"
import { providerInfo } from "../../../shared/providers.ts"
import { binariesAtom, modelsAtom, updateSettingsAtom } from "../../lib/rpc.ts"
import { useAgentBinaries, useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { accessModes, effortLabel } from "../ComposerControls.tsx"
import { ProviderIcon, providerLabel } from "../ProviderIcon.tsx"
import { Badge } from "../ui/badge.tsx"
import { Button, buttonVariants } from "../ui/button.tsx"
import { Checkbox } from "../ui/checkbox.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Switch } from "../ui/switch.tsx"
import { Input } from "../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { AccountsSection } from "./AccountSettings.tsx"
import { MagpieConnectionField } from "./MagpieConnectionField.tsx"
import {
  SETTINGS_FILL_WIDTH,
  SettingsPanelSection,
  settingsRowsClass,
  settingsSurfaceClass,
} from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"
import { SkeletonList } from "../ui/skeleton.tsx"

export function ModelSettings() {
  const { defaultProvider } = useSettings(useSettingsEnvironment())
  const [selected, setSelected] = useState<ProviderId>(defaultProvider)
  const detailRef = useRef<HTMLElement>(null)

  const select = (provider: ProviderId) => {
    startTransition(() => setSelected(provider))
    detailRef.current?.scrollIntoView({ block: "nearest" })
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 scrollbar-gutter-both overflow-y-auto @4xl:overflow-hidden">
        <div
          className={cn(
            "mx-auto grid w-full gap-6 px-8 pb-8 @4xl:h-full @4xl:grid-cols-[20rem_minmax(0,1fr)] @4xl:grid-rows-[minmax(0,1fr)]",
            SETTINGS_FILL_WIDTH,
          )}
        >
          <div className="flex min-h-0 flex-col gap-6">
            <NewThreadsGroup />
            <AgentList selected={selected} onSelect={select} />
          </div>
          <AgentDetail key={selected} ref={detailRef} provider={selected} />
        </div>
      </div>
    </div>
  )
}

interface PanelProps {
  readonly title: string
  readonly icon?: ReactNode
  readonly className?: string
  readonly ref?: Ref<HTMLElement>
  readonly children: ReactNode
}

function Panel({ title, icon, className, ref, children }: PanelProps) {
  const headingId = useId()
  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      className={cn(settingsSurfaceClass, "flex min-h-0 flex-col", className)}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-foreground/8 px-4">
        {icon}
        <h2 id={headingId} className="min-w-0 truncate text-sm font-semibold">
          {title}
        </h2>
      </header>
      {children}
    </section>
  )
}

function NewThreadsGroup() {
  return (
    <Panel title={m.settings_new_threads()} className="shrink-0">
      <div className={settingsRowsClass}>
        <DefaultAccessField />
        <TextGenerationModelField />
        <PullRequestGuideField />
      </div>
    </Panel>
  )
}

function AgentList({ selected, onSelect }: { selected: ProviderId; onSelect: (provider: ProviderId) => void }) {
  const environment = useSettingsEnvironment()
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })

  const setEnabled = (provider: ProviderId, enabled: boolean) =>
    void updateSettings({ providerEnabled: { [provider]: enabled } }).catch(() => undefined)

  return (
    <Panel title={m.settings_agents()}>
      <ul
        aria-label={m.settings_agents()}
        className="flex max-h-96 min-h-0 scrollbar-gutter-stable flex-col gap-0.5 overflow-y-auto p-1.5 @4xl:max-h-none"
      >
        {ProviderId.literals.map((provider) => (
          <AgentRow
            key={provider}
            provider={provider}
            selected={provider === selected}
            onSelect={() => onSelect(provider)}
            onEnabledChange={(enabled) => setEnabled(provider, enabled)}
          />
        ))}
      </ul>
    </Panel>
  )
}

interface AgentRowProps {
  readonly provider: ProviderId
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onEnabledChange: (enabled: boolean) => void
}

function AgentRow({ provider, selected, onSelect, onEnabledChange }: AgentRowProps) {
  const environment = useSettingsEnvironment()
  const { providerEnabled, defaultModel } = useSettings(environment)
  const missing = useAgentBinaries(environment)?.[provider].installed === false
  const enabled = providerEnabled[provider] && !missing
  const model = defaultModel[provider]
  const label = providerLabel[provider]()
  return (
    <li
      className={cn(
        "relative flex h-14 shrink-0 items-center gap-3 rounded-lg px-2.5 transition-colors",
        selected ? "bg-foreground/7" : "hover:bg-foreground/4",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background">
        <ProviderIcon provider={provider} muted={!enabled} className="size-4" />
      </span>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
      >
        <span className={cn("max-w-full truncate text-sm font-medium", !enabled && "text-muted-foreground")}>
          {label}
        </span>
        <span
          className={cn("max-w-full truncate text-xs text-muted-foreground", !missing && model !== null && "font-mono")}
        >
          {missing ? m.settings_provider_not_installed() : (model ?? m.settings_model_agent_default())}
        </span>
      </button>
      <Switch
        aria-label={m.settings_provider_toggle({ provider: label })}
        checked={enabled}
        disabled={missing}
        onCheckedChange={onEnabledChange}
      />
    </li>
  )
}

const binaryOwner = (provider: ProviderId) =>
  ProviderId.literals.find((candidate) => providerInfo[candidate].binary === providerInfo[provider].binary) ?? provider

function AgentDetail({ provider, ref }: { provider: ProviderId; ref: Ref<HTMLElement> }) {
  const environment = useSettingsEnvironment()
  const { providerEnabled } = useSettings(environment)
  const binary = useAgentBinaries(environment)?.[provider]
  const label = providerLabel[provider]()
  const owner = binaryOwner(provider)
  return (
    <Panel
      ref={ref}
      title={label}
      icon={<ProviderIcon provider={provider} className="size-4" />}
      className="self-start @4xl:max-h-full"
    >
      {binary?.installed === false ? (
        <div className="flex min-h-0 scrollbar-gutter-stable flex-col divide-y divide-foreground/8 @4xl:overflow-y-auto">
          <MissingAgentNotice provider={provider} />
          {owner === provider && <BinaryPathField provider={provider} />}
        </div>
      ) : providerEnabled[provider] ? (
        <div className="flex min-h-0 scrollbar-gutter-stable flex-col divide-y divide-foreground/8 @4xl:overflow-y-auto">
          {owner === provider && <BinaryPathField provider={provider} />}
          <AccountsSection provider={provider} />
          {provider === "magpie" && (
            <SettingsPanelSection title={m.settings_magpie_gateway()}>
              <MagpieConnectionField />
            </SettingsPanelSection>
          )}
          <ModelsSection provider={provider} />
          {providerInfo[provider].autoCompacts && <AutoCompactField provider={provider} />}
        </div>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">{m.settings_provider_off({ provider: label })}</p>
      )}
    </Panel>
  )
}

function MissingAgentNotice({ provider }: { provider: ProviderId }) {
  const label = providerLabel[provider]()
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <p className="text-sm text-muted-foreground">{m.settings_provider_missing({ provider: label })}</p>
      <a
        href={providerInfo[provider].installUrl}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        {m.settings_provider_install({ provider: label })}
      </a>
    </div>
  )
}

function BinaryPathField({ provider }: { provider: ProviderId }) {
  const environment = useSettingsEnvironment()
  const { providerBinary } = useSettings(environment)
  const binary = useAgentBinaries(environment)?.[provider]
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const refreshBinaries = useAtomRefresh(binariesAtom(environment))
  const current = providerBinary[provider]
  const [draft, setDraft] = useState(current ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, startSaving] = useTransition()
  const inputId = `cli-path-${provider}`
  const next = draft.trim()

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startSaving(async () => {
      setError(null)
      try {
        await updateSettings({ providerBinary: { [provider]: next === "" ? null : next } })
        refreshBinaries()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <SettingsPanelSection title={m.settings_cli_path()}>
      <Field data-invalid={(current !== null && binary?.installed === false) || undefined}>
        <FieldLabel htmlFor={inputId} className="sr-only">
          {m.settings_cli_path()}
        </FieldLabel>
        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <Input
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={binary?.path ?? providerInfo[provider].binary}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" variant="outline" disabled={next === (current ?? "") || pending}>
            {m.settings_save()}
          </Button>
        </form>
        {current !== null && binary?.installed === false && (
          <FieldError>{m.settings_cli_path_missing({ path: current })}</FieldError>
        )}
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </SettingsPanelSection>
  )
}

function ModelsSection({ provider }: { provider: ProviderId }) {
  const environment = useSettingsEnvironment()
  const models = useAtomValue(modelsAtom(environment, provider))
  const { defaultModel } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const current = defaultModel[provider]
  const label = providerLabel[provider]()

  const saveDefault = async (model: string | null) => {
    setError(null)
    try {
      await updateSettings({ defaultModel: { [provider]: model } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const textFallback = (notice: string) => (
    <ModelIdField provider={provider} current={current} notice={notice} onSave={saveDefault} />
  )

  return (
    <SettingsPanelSection title={m.settings_models()}>
      {AsyncResult.builder(models)
        .onInitial(() => <SkeletonList label={m.settings_models_loading()} rows={3} rowClassName="h-10 rounded-lg" />)
        .onSuccess((list) =>
          list.length > 0 ? (
            <>
              <DefaultModelField provider={provider} models={list} current={current} onSave={saveDefault} />
              <DefaultEffortField
                provider={provider}
                model={list.find((model) => model.id === current) ?? list[0]!}
                onError={setError}
              />
              <ModelList provider={provider} models={list} current={current} />
            </>
          ) : (
            textFallback(m.settings_models_unlisted({ provider: label }))
          ),
        )
        .onError((cause) => textFallback(m.settings_models_failed({ provider: label, message: errorMessage(cause) })))
        .orElse(() => textFallback(m.settings_models_unlisted({ provider: label })))}
      {error && <FieldError>{error}</FieldError>}
    </SettingsPanelSection>
  )
}

interface ModelListProps {
  readonly provider: ProviderId
  readonly models: ReadonlyArray<ModelInfo>
  readonly current: string | null
}

const AGENT_DEFAULT = ""

function DefaultModelField({
  provider,
  models,
  current,
  onSave,
}: ModelListProps & { onSave: (model: string | null) => Promise<void> }) {
  const inputId = `default-model-${provider}`
  const listed = current === null || models.some((model) => model.id === current)
  const items = [
    { value: AGENT_DEFAULT, label: m.settings_model_agent_default() },
    ...(listed ? [] : [{ value: current, label: current }]),
    ...models.map((model) => ({ value: model.id, label: model.label })),
  ]
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={inputId} className="self-center">
        {m.settings_default_model()}
      </FieldLabel>
      <Select
        items={items}
        value={current ?? AGENT_DEFAULT}
        onValueChange={(next) => next !== null && void onSave(next === AGENT_DEFAULT ? null : next)}
      >
        <SelectTrigger id={inputId} className="w-56 min-w-0 shrink">
          <SelectValue className="min-w-0 truncate" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

interface DefaultEffortFieldProps {
  readonly provider: ProviderId
  readonly model: ModelInfo
  readonly onError: (message: string | null) => void
}

function DefaultEffortField({ provider, model, onError }: DefaultEffortFieldProps) {
  const environment = useSettingsEnvironment()
  const { defaultEffort } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const current = defaultEffort[provider]
  if (model.efforts.length === 0 && current === null) return null

  const inputId = `default-effort-${provider}`
  const items = [
    {
      value: AGENT_DEFAULT,
      label: model.defaultEffort
        ? m.thread_effort_default_named({ effort: effortLabel(model.defaultEffort) })
        : m.settings_effort_model_default(),
    },
    ...[...new Set([...model.efforts, ...(current === null ? [] : [current])])].map((effort) => ({
      value: effort,
      label: effortLabel(effort),
    })),
  ]

  const save = async (effort: string | null) => {
    onError(null)
    try {
      await updateSettings({ defaultEffort: { [provider]: effort } })
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={inputId} className="self-center">
        {m.thread_effort_default()}
      </FieldLabel>
      <Select
        items={items}
        value={current ?? AGENT_DEFAULT}
        onValueChange={(next) => next !== null && void save(next === AGENT_DEFAULT ? null : next)}
      >
        <SelectTrigger id={inputId} className="w-56 min-w-0 shrink">
          <SelectValue className="min-w-0 truncate" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function ModelList({ provider, models, current }: ModelListProps) {
  const environment = useSettingsEnvironment()
  const { modelPresets } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const listed = models.map((model) => model.id)
  const isListed = new Set(listed)
  const preset = modelPresets[provider].filter((id) => isListed.has(id))
  const shown = new Set(preset.length === 0 ? listed : preset)
  const rows = current === null || isListed.has(current) ? models : [unlistedModel(current, provider), ...models]

  const setShown = async (id: string, show: boolean) => {
    const next = listed.filter((other) => (other === id ? show : shown.has(other)))
    setError(null)
    try {
      await updateSettings({
        modelPresets: { [provider]: next.length === listed.length ? [] : next },
      })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <p aria-hidden className="px-2.5 text-end text-xs text-muted-foreground">
        {m.settings_model_shown()}
      </p>
      <ul aria-label={m.settings_models_label({ provider: providerLabel[provider]() })} className="flex flex-col">
        {rows.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            isDefault={model.id === current}
            shown={isListed.has(model.id) ? shown.has(model.id) : null}
            lastShown={shown.size === 1}
            onShownChange={(show) => void setShown(model.id, show)}
          />
        ))}
      </ul>
      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}

interface ModelRowProps {
  readonly model: ModelInfo
  readonly isDefault: boolean
  readonly shown: boolean | null
  readonly lastShown: boolean
  readonly onShownChange: (shown: boolean) => void
}

function ModelRow({ model, isDefault, shown, lastShown, onShownChange }: ModelRowProps) {
  return (
    <li className="flex h-10 items-center gap-3 rounded-lg px-2.5">
      <span className="min-w-0 flex-1 truncate text-sm" title={model.id}>
        {model.label}
      </span>
      {isDefault && <Badge>{m.settings_model_default()}</Badge>}
      {shown === null ? (
        <span aria-hidden className="size-4 shrink-0" />
      ) : (
        <Checkbox
          aria-label={m.settings_model_show_in_picker({ model: model.label })}
          checked={shown}
          disabled={shown && lastShown}
          onCheckedChange={onShownChange}
        />
      )}
    </li>
  )
}

interface ModelIdFieldProps {
  readonly provider: ProviderId
  readonly current: string | null
  readonly notice: string
  readonly onSave: (model: string | null) => Promise<void>
}

function ModelIdField({ provider, current, notice, onSave }: ModelIdFieldProps) {
  const [draft, setDraft] = useState(current ?? "")
  const [pending, startSaving] = useTransition()
  const inputId = `default-model-${provider}`
  const next = draft.trim()

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startSaving(() => onSave(next === "" ? null : next))
  }

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{m.settings_default_model()}</FieldLabel>
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Input
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={m.thread_model_placeholder()}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 font-mono"
        />
        <Button type="submit" variant="outline" disabled={next === (current ?? "") || pending}>
          {m.settings_save()}
        </Button>
      </form>
      <FieldDescription>{notice}</FieldDescription>
    </Field>
  )
}

function AutoCompactField({ provider }: { provider: ProviderId }) {
  const environment = useSettingsEnvironment()
  const { autoCompactTokens } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const [pending, startSaving] = useTransition()
  const current = autoCompactTokens[provider]
  const [draft, setDraft] = useState(current === null ? "" : String(current / 1000))
  const inputId = `auto-compact-${provider}`
  const inputRef = useRef<HTMLInputElement>(null)
  const next = draft.trim() === "" ? null : Number(draft) * 1000

  const save = (tokens: number | null) =>
    startSaving(async () => {
      setError(null)
      try {
        await updateSettings({ autoCompactTokens: { [provider]: tokens } })
        setDraft(tokens === null ? "" : String(tokens / 1000))
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    save(next)
  }

  const clear = () => {
    save(null)
    inputRef.current?.focus()
  }

  return (
    <Field orientation="horizontal" className="flex-wrap p-4">
      <FieldContent className="self-center">
        <FieldLabel htmlFor={inputId}>{m.settings_auto_compact()}</FieldLabel>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center justify-end gap-2">
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
          className="w-32 shrink-0 tabular-nums"
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
    </Field>
  )
}

const newThreadControlClass = "w-44 shrink-0"

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
      <FieldContent className="self-center">
        <FieldLabel htmlFor={inputId}>{m.settings_default_access()}</FieldLabel>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <div className={newThreadControlClass}>
        <Select items={items} value={defaultAccessMode} onValueChange={(next) => void save(next)}>
          <SelectTrigger id={inputId} className="w-full">
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
      <FieldContent className="self-center">
        <FieldLabel htmlFor={inputId}>{m.settings_text_generation_model()}</FieldLabel>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <div className={newThreadControlClass}>
        <ModelSelect inputId={inputId} models={items} current={textGenerationModel} onSave={save} />
      </div>
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

  const save = async (patch: Partial<typeof pullRequestGuide>) => {
    setError(null)
    try {
      await updateSettings({ pullRequestGuide: patch })
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
    <>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="pull-request-guide-enabled">{m.settings_guide_model()}</FieldLabel>
        <Switch
          id="pull-request-guide-enabled"
          checked={pullRequestGuide.enabled}
          onCheckedChange={(enabled) => void save({ enabled })}
        />
      </Field>
      {pullRequestGuide.enabled && (
        <Field>
          <FieldLabel htmlFor={inputId} className="sr-only">
            {m.settings_guide_model_picker()}
          </FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-40">
              <ModelSelect inputId={inputId} models={items} current={pullRequestGuide.model} onSave={saveModel} />
            </div>
            <Select
              items={effortItems}
              value={pullRequestGuide.effort}
              onValueChange={(effort) => effort !== null && void save({ effort })}
            >
              <SelectTrigger aria-label={m.thread_effort_picker()} className="min-w-0 flex-1 basis-28">
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
        </Field>
      )}
      {error && <FieldError>{error}</FieldError>}
    </>
  )
}

interface ModelSelectProps {
  readonly inputId: string
  readonly models: ReadonlyArray<ModelInfo>
  readonly current: string | null
  readonly onSave: (model: string | null) => Promise<void>
}

function ModelSelect({ inputId, models, current, onSave }: ModelSelectProps) {
  const items = models.map((model) => ({ value: model.id, label: model.label }))
  return (
    <Select items={items} value={current} onValueChange={(next) => void onSave(next)}>
      <SelectTrigger id={inputId} className="w-full">
        <SelectValue placeholder={m.settings_models_pick()} className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
