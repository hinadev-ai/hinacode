import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState, useTransition } from "react"
import { type ModelInfo, ProviderId, unlistedModel } from "../../../shared/agent.ts"
import { AccessMode } from "../../../shared/domain.ts"
import { modelsAtom, updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { accessModes } from "../ComposerControls.tsx"
import { ProviderIcon } from "../ProviderIcon.tsx"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"
import { SkeletonList } from "../ui/skeleton.tsx"

const providerLabel = { claude: m.provider_claude, codex: m.provider_codex } satisfies Record<ProviderId, () => string>

export function ModelSettings() {
  return (
    <SettingsSection title={m.settings_models()} description={m.settings_models_hint()}>
      <FieldGroup>
        {ProviderId.literals.map((provider) => (
          <DefaultModelField key={provider} provider={provider} />
        ))}
        <DefaultAccessField />
        <TextGenerationModelField />
      </FieldGroup>
    </SettingsSection>
  )
}

function DefaultModelField({ provider }: { provider: ProviderId }) {
  const models = useAtomValue(modelsAtom(provider))
  const { defaultModel } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
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
    <>
      <ModelIdForm inputId={inputId} current={current} onSave={save} />
      <FieldDescription>{notice}</FieldDescription>
    </>
  )

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>
        <ProviderIcon provider={provider} />
        {label}
      </FieldLabel>
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
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

function DefaultAccessField() {
  const { defaultAccessMode } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
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
    <Field>
      <FieldLabel htmlFor={inputId}>{m.settings_default_access()}</FieldLabel>
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
      <FieldDescription>{m.settings_default_access_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** Thread naming runs through the Claude Agent SDK, so only Claude models are offered. */
function TextGenerationModelField() {
  const models = useAtomValue(modelsAtom("claude"))
  const { textGenerationModel } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
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
    <Field>
      <FieldLabel htmlFor={inputId}>{m.settings_text_generation_model()}</FieldLabel>
      <ModelSelect inputId={inputId} models={items} current={textGenerationModel} onSave={save} clearable={false} />
      <FieldDescription>{m.settings_text_generation_model_hint()}</FieldDescription>
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
