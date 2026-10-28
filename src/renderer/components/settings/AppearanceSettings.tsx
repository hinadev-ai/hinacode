import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { useId, useState } from "react"
import { type Appearance, ThemeId } from "../../../shared/domain.ts"
import { applyContrast, installedFontsAtom, themes, useTheme } from "../../lib/appearance.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateClientSettingsAtom } from "../../lib/rpc.ts"
import { useClientSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "../ui/field.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { SkeletonList } from "../ui/skeleton.tsx"
import { Slider } from "../ui/slider.tsx"
import { SettingsGroup, SettingsSection } from "./SettingsSection.tsx"

const fontSizes = [12, 13, 14, 15, 16, 17, 18, 20].map((size) => ({ value: size, label: `${size}px` }))

export function AppearanceSettings() {
  const { appearance } = useClientSettings()
  const updateClientSettings = useAtomSet(updateClientSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)

  const save = async (patch: Partial<Appearance>) => {
    setError(null)
    try {
      await updateClientSettings({ appearance: { ...appearance, ...patch } })
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    }
  }

  return (
    <SettingsSection title={m.settings_appearance()}>
      <SettingsGroup>
        {/* A legend sits on the fieldset's top edge and ignores its padding, so the row is a wrapper. */}
        <div>
          <ThemePicker current={appearance.theme} onPick={(theme) => void save({ theme })} />
        </div>
      </SettingsGroup>
      <SettingsGroup>
        <ContrastField saved={appearance.contrast} onCommit={(contrast) => save({ contrast })} />
        <Field orientation="horizontal">
          <FieldLabel htmlFor="settings-font-size">{m.settings_font_size()}</FieldLabel>
          <Select
            items={fontSizes}
            value={appearance.fontSize}
            onValueChange={(fontSize) => fontSize !== null && void save({ fontSize })}
          >
            <SelectTrigger id="settings-font-size" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fontSizes.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <FontField
          id="settings-ui-font"
          label={m.settings_ui_font()}
          bundled="DM Sans"
          kind="all"
          current={appearance.uiFont}
          onPick={(uiFont) => void save({ uiFont })}
        />
        <FontField
          id="settings-mono-font"
          label={m.settings_mono_font()}
          description={m.settings_mono_font_hint()}
          bundled="Geist Mono"
          kind="monospace"
          current={appearance.monoFont}
          onPick={(monoFont) => void save({ monoFont })}
        />
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
    </SettingsSection>
  )
}

function ThemePicker({ current, onPick }: { current: ThemeId; onPick: (theme: ThemeId) => void }) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{m.settings_theme()}</FieldLegend>
      <div className="grid grid-cols-3 gap-3">
        {ThemeId.literals.map((id) => (
          <label key={id} className="group/theme flex cursor-pointer flex-col gap-1.5">
            <input
              type="radio"
              name="theme"
              value={id}
              checked={id === current}
              onChange={() => onPick(id)}
              className="peer sr-only"
            />
            <ThemePreview id={id} />
            <span className="text-sm text-muted-foreground peer-checked:font-medium peer-checked:text-foreground">
              {themes[id].label()}
            </span>
          </label>
        ))}
      </div>
    </FieldSet>
  )
}

function ThemePreview({ id }: { id: ThemeId }) {
  const theme = useTheme(id)
  const neutral = id === "default" || id === "system" || id === "light"
  return (
    <div
      data-theme={neutral ? (theme.scheme === "light" ? "light" : undefined) : id}
      aria-hidden
      className={cn(
        theme.scheme === "dark" && "dark",
        "flex h-20 overflow-hidden rounded-lg border border-border bg-background ring-offset-2 ring-offset-background transition-shadow duration-150 ease-out group-hover/theme:ring-2 group-hover/theme:ring-ring/40 peer-checked:ring-2 peer-checked:ring-ring peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
      )}
    >
      <div className="flex w-1/3 flex-col gap-1.5 border-r border-border bg-sidebar p-2">
        <span className="h-1.5 w-3/4 rounded-full bg-muted-foreground/60" />
        <span className="h-1.5 w-full rounded-full bg-muted" />
        <span className="h-1.5 w-2/3 rounded-full bg-muted-foreground/40" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="h-1.5 w-full rounded-full bg-foreground/80" />
        <span className="h-1.5 w-4/5 rounded-full bg-muted-foreground/60" />
        <span className="mt-auto h-3 w-8 self-end rounded-sm bg-primary" />
      </div>
    </div>
  )
}

const contrastLabel = (contrast: number) =>
  contrast === 0
    ? m.settings_contrast_standard()
    : contrast > 0
      ? m.settings_contrast_higher({ percent: contrast })
      : m.settings_contrast_lower({ percent: -contrast })

/**
 * Previews on the root while the thumb moves and saves once it settles, so a drag never waits on the rpc.
 * A failed save keeps the draft, so the slider still matches what the app renders next to the error.
 */
function ContrastField({ saved, onCommit }: { saved: number; onCommit: (contrast: number) => Promise<boolean> }) {
  const labelId = useId()
  const [draft, setDraft] = useState<number | null>(null)
  const contrast = draft ?? saved
  const preview = (value: number) => {
    setDraft(value)
    applyContrast(value)
  }
  const commit = async (value: number) => {
    if (await onCommit(value)) setDraft(null)
  }
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel id={labelId}>{m.settings_contrast()}</FieldLabel>
      </FieldContent>
      <div className="flex w-56 shrink-0 flex-col gap-2">
        <span className="self-end text-sm text-muted-foreground tabular-nums">{contrastLabel(contrast)}</span>
        <Slider
          aria-labelledby={labelId}
          className="py-1.5"
          min={-100}
          max={100}
          step={10}
          value={contrast}
          onValueChange={preview}
          onValueCommitted={(value) => void commit(value)}
          thumbAlignment="center"
        />
      </div>
    </Field>
  )
}

interface FontFieldProps {
  readonly id: string
  readonly label: string
  readonly description?: string
  /** The bundled font used when nothing is picked. */
  readonly bundled: string
  readonly kind: "all" | "monospace"
  readonly current: string | null
  readonly onPick: (font: string | null) => void
}

function FontField({ id, label, description, bundled, kind, current, onPick }: FontFieldProps) {
  const fonts = useAtomValue(installedFontsAtom)
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      {AsyncResult.builder(fonts)
        .onInitial(() => (
          <SkeletonList label={m.settings_fonts_loading()} rows={1} rowClassName="h-8 w-72 rounded-lg" />
        ))
        .onSuccess((installed) => {
          const items = [
            { value: null, label: m.settings_font_default({ font: bundled }) },
            ...installed[kind].map((family) => ({ value: family, label: family })),
          ]
          return (
            <Select items={items} value={current} onValueChange={onPick}>
              <SelectTrigger id={id} className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem
                    key={item.value ?? ""}
                    value={item.value}
                    style={{ fontFamily: JSON.stringify(item.value ?? `${bundled} Variable`) }}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        })
        .onError((cause) => <FieldError>{m.settings_fonts_failed({ message: errorMessage(cause) })}</FieldError>)
        .orNull()}
    </Field>
  )
}
