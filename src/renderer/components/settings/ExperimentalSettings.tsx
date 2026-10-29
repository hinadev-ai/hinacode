import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState } from "react"
import { RiCheckboxCircleFill } from "react-icons/ri"
import type {
  BoatVmSize,
  ExperimentalSettings as ExperimentalSettingsValue,
  VmHostStatus,
  VmProvider,
  VmTemplate,
} from "../../../shared/domain.ts"
import { formatEnvLines, parseEnvLines } from "../../lib/envLines.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom, vmHostAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Switch } from "../ui/switch.tsx"
import { Textarea } from "../ui/textarea.tsx"
import { VmTemplateSelect } from "../sidePanel/TinyVmView.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { SecretField } from "./IntegrationSettings.tsx"
import { SettingsGroup, SettingsSection } from "./SettingsSection.tsx"

const BOAT_SIZES: ReadonlyArray<BoatVmSize> = ["small", "default", "large", "xlarge"]
const isBoatSize = (value: string): value is BoatVmSize => BOAT_SIZES.some((size) => size === value)
const isVmProvider = (value: string): value is VmProvider => value === "sbx" || value === "boat"

type SetExperimental = (patch: Partial<ExperimentalSettingsValue>) => Promise<void>

export function ExperimentalSettings() {
  const environment = useSettingsEnvironment()
  const { experimental } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)

  const setExperimental: SetExperimental = async (patch) => {
    setError(null)
    try {
      await updateSettings({ experimental: { ...experimental, ...patch } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <SettingsSection title={m.settings_experimental()} description={m.settings_experimental_hint()}>
      <SettingsGroup>
        <TinyVmSettings experimental={experimental} setExperimental={setExperimental} />
        <DevicesSettings experimental={experimental} setExperimental={setExperimental} />
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
    </SettingsSection>
  )
}

function TinyVmSettings({
  experimental,
  setExperimental,
}: {
  experimental: ExperimentalSettingsValue
  setExperimental: SetExperimental
}) {
  return (
    <>
      <VmSwitchField
        id="settings-experimental-tiny-vm"
        label={m.settings_tiny_vm()}
        hint={m.settings_tiny_vm_hint()}
        checked={experimental.tinyVm}
        onCheckedChange={(checked) => void setExperimental({ tinyVm: checked })}
      />
      {experimental.tinyVm && (
        <>
          <VmProviderField
            value={experimental.tinyVmProvider}
            onChange={(tinyVmProvider) => void setExperimental({ tinyVmProvider })}
          />
          <VmHost provider={experimental.tinyVmProvider} />
          {experimental.tinyVmProvider === "boat" ? (
            <BoatVmFields experimental={experimental} setExperimental={setExperimental} />
          ) : (
            <SbxVmFields experimental={experimental} setExperimental={setExperimental} />
          )}
          <VmSetupScriptField
            value={experimental.tinyVmSetupScript}
            onChange={(tinyVmSetupScript) => void setExperimental({ tinyVmSetupScript })}
          />
          <VmEnvField value={experimental.tinyVmEnv} onChange={(tinyVmEnv) => void setExperimental({ tinyVmEnv })} />
        </>
      )}
    </>
  )
}

function BoatVmFields({
  experimental,
  setExperimental,
}: {
  experimental: ExperimentalSettingsValue
  setExperimental: SetExperimental
}) {
  return (
    <>
      <BoatKeyField />
      <VmTemplateField
        id="settings-experimental-tiny-vm-boat-size"
        label={m.settings_tiny_vm_boat_size()}
        hint={m.settings_tiny_vm_boat_size_hint()}
        provider="boat"
        value={experimental.tinyVmBoatSize}
        onChange={(name) => isBoatSize(name) && void setExperimental({ tinyVmBoatSize: name })}
      />
    </>
  )
}

function SbxVmFields({
  experimental,
  setExperimental,
}: {
  experimental: ExperimentalSettingsValue
  setExperimental: SetExperimental
}) {
  return (
    <>
      <VmTemplateField
        id="settings-experimental-tiny-vm-template"
        label={m.settings_tiny_vm_template()}
        hint={m.settings_tiny_vm_template_hint()}
        provider="sbx"
        value={experimental.tinyVmTemplate}
        onChange={(name) => void setExperimental({ tinyVmTemplate: name })}
      />
      <VmSwitchField
        id="settings-experimental-tiny-vm-profile"
        label={m.settings_tiny_vm_profile()}
        hint={m.settings_tiny_vm_profile_hint()}
        checked={experimental.tinyVmProfile}
        onCheckedChange={(checked) => void setExperimental({ tinyVmProfile: checked })}
      />
      <VmSwitchField
        id="settings-experimental-tiny-vm-passkeys"
        label={m.settings_tiny_vm_passkeys()}
        hint={m.settings_tiny_vm_passkeys_hint()}
        checked={experimental.tinyVmPasskeys}
        onCheckedChange={(checked) => void setExperimental({ tinyVmPasskeys: checked })}
      />
    </>
  )
}

function DevicesSettings({
  experimental,
  setExperimental,
}: {
  experimental: ExperimentalSettingsValue
  setExperimental: SetExperimental
}) {
  const boatKeyShown = experimental.tinyVm && experimental.tinyVmProvider === "boat"
  return (
    <>
      <VmSwitchField
        id="settings-experimental-devices"
        label={m.settings_devices()}
        hint={m.settings_devices_hint()}
        checked={experimental.devices}
        onCheckedChange={(checked) => void setExperimental({ devices: checked })}
      />
      {experimental.devices && !boatKeyShown && <BoatKeyField />}
    </>
  )
}

function BoatKeyField() {
  return (
    <SecretField
      name="boat.apiKey"
      label={m.settings_boat_key_label()}
      placeholder={m.settings_boat_key_placeholder()}
      hint={m.settings_boat_key_hint()}
    />
  )
}

function VmSwitchField({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{hint}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  )
}

function VmProviderField({ value, onChange }: { value: VmProvider; onChange: (provider: VmProvider) => void }) {
  const items = [
    { value: "boat", label: m.settings_tiny_vm_provider_boat() },
    { value: "sbx", label: m.settings_tiny_vm_provider_sbx() },
  ]
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="settings-experimental-tiny-vm-provider">{m.settings_tiny_vm_provider()}</FieldLabel>
        <FieldDescription>{m.settings_tiny_vm_provider_hint()}</FieldDescription>
      </FieldContent>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => typeof next === "string" && isVmProvider(next) && onChange(next)}
      >
        <SelectTrigger id="settings-experimental-tiny-vm-provider" className="w-full">
          <SelectValue />
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

function VmTemplateField({
  id,
  label,
  hint,
  provider,
  value,
  onChange,
}: {
  id: string
  label: string
  hint: string
  provider: VmProvider
  value: string
  onChange: (name: string) => void
}) {
  const environment = useSettingsEnvironment()
  const host = useAtomValue(vmHostAtom(environment))
  const templates: ReadonlyArray<VmTemplate> =
    AsyncResult.isSuccess(host) && host.value.status === "connected" && host.value.provider === provider
      ? host.value.templates
      : []
  if (templates.length === 0) return null
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{hint}</FieldDescription>
      </FieldContent>
      <VmTemplateSelect id={id} templates={templates} value={value} onChange={onChange} />
    </Field>
  )
}

function VmSetupScriptField({ value, onChange }: { value: string; onChange: (script: string) => void }) {
  return (
    <Field>
      <FieldLabel htmlFor="settings-experimental-tiny-vm-setup">{m.settings_tiny_vm_setup()}</FieldLabel>
      <Textarea
        id="settings-experimental-tiny-vm-setup"
        rows={4}
        defaultValue={value}
        className="font-mono text-xs"
        placeholder={m.settings_tiny_vm_setup_placeholder()}
        spellCheck={false}
        onBlur={(event) => event.target.value !== value && onChange(event.target.value)}
      />
      <FieldDescription>{m.settings_tiny_vm_setup_hint()}</FieldDescription>
    </Field>
  )
}

function VmEnvField({
  value,
  onChange,
}: {
  value: Readonly<Record<string, string>>
  onChange: (env: Record<string, string>) => void
}) {
  const [invalidLine, setInvalidLine] = useState<number | null>(null)
  const saved = formatEnvLines(value)
  const save = (text: string) => {
    const parsed = parseEnvLines(text)
    if ("invalidLine" in parsed) return setInvalidLine(parsed.invalidLine)
    setInvalidLine(null)
    if (formatEnvLines(parsed.env) !== saved) onChange(parsed.env)
  }

  return (
    <Field data-invalid={invalidLine !== null || undefined}>
      <FieldLabel htmlFor="settings-experimental-tiny-vm-env">{m.settings_tiny_vm_env()}</FieldLabel>
      <Textarea
        id="settings-experimental-tiny-vm-env"
        rows={3}
        defaultValue={saved}
        className="font-mono text-xs"
        placeholder={m.settings_tiny_vm_env_placeholder()}
        spellCheck={false}
        aria-invalid={invalidLine !== null || undefined}
        onBlur={(event) => save(event.target.value)}
      />
      {invalidLine === null ? (
        <FieldDescription>{m.settings_tiny_vm_env_hint()}</FieldDescription>
      ) : (
        <FieldError>{m.settings_tiny_vm_env_invalid({ line: String(invalidLine) })}</FieldError>
      )}
    </Field>
  )
}

function VmHost({ provider }: { provider: VmProvider }) {
  const environment = useSettingsEnvironment()
  const host = useAtomValue(vmHostAtom(environment))
  const refresh = useAtomRefresh(vmHostAtom(environment))
  const stale = AsyncResult.isSuccess(host) && host.value.provider !== provider

  useEffect(() => {
    if (stale) refresh()
  }, [stale, refresh])

  const checkAgain = (
    <Button variant="ghost" size="xs" disabled={host.waiting} onClick={refresh}>
      {m.settings_tiny_vm_check_again()}
    </Button>
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p aria-live="polite" className="flex items-center gap-1.5 text-sm">
        {AsyncResult.builder(host)
          .onInitial(() => <span className="text-muted-foreground">{m.settings_tiny_vm_checking()}</span>)
          .onSuccess((status) =>
            status.provider === provider ? (
              <HostStatus status={status} />
            ) : (
              <span className="text-muted-foreground">{m.settings_tiny_vm_checking()}</span>
            ),
          )
          .onError((cause) => <span className="text-destructive">{errorMessage(cause)}</span>)
          .orElse(() => null)}
      </p>
      {AsyncResult.isSuccess(host) && !stale && host.value.status === "connected" ? null : checkAgain}
    </div>
  )
}

const withCode = (text: string) =>
  text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed sentence never reorder.
      <code key={index} className="font-mono text-[0.85em] text-foreground">
        {part}
      </code>
    ) : (
      part
    ),
  )

function HostStatus({ status }: { status: VmHostStatus }) {
  switch (status.status) {
    case "connected":
      return (
        <>
          <RiCheckboxCircleFill aria-hidden className="size-4 text-success" />
          {status.provider === "boat"
            ? m.settings_tiny_vm_boat_connected({
                sandboxes: String(status.sandboxes),
                max: String(status.maxSandboxes),
              })
            : m.settings_tiny_vm_connected({
                host: hostOf(status.url),
                sandboxes: String(status.sandboxes),
                max: String(status.maxSandboxes),
              })}
        </>
      )
    case "notConfigured":
      return (
        <span className="text-muted-foreground">
          {withCode(
            status.provider === "boat" ? m.settings_tiny_vm_boat_not_configured() : m.settings_tiny_vm_not_configured(),
          )}
        </span>
      )
    case "unreachable":
      return (
        <span className="text-destructive">
          {m.settings_tiny_vm_unreachable({ url: status.url, message: status.message })}
        </span>
      )
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
