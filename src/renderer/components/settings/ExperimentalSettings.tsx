import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { RiCheckboxCircleFill } from "react-icons/ri"
import type { VmHostStatus, VmTemplate } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom, vmHostAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Switch } from "../ui/switch.tsx"
import { VmTemplateSelect } from "../sidePanel/TinyVmView.tsx"
import { SettingsGroup, SettingsSection } from "./SettingsSection.tsx"

export function ExperimentalSettings() {
  const environment = useSettingsEnvironment()
  const { experimental } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)

  const setTinyVm = async (tinyVm: boolean) => {
    setError(null)
    try {
      await updateSettings({ experimental: { ...experimental, tinyVm } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const setProfile = async (tinyVmProfile: boolean) => {
    setError(null)
    try {
      await updateSettings({ experimental: { ...experimental, tinyVmProfile } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const setPasskeys = async (tinyVmPasskeys: boolean) => {
    setError(null)
    try {
      await updateSettings({ experimental: { ...experimental, tinyVmPasskeys } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const setTemplate = async (tinyVmTemplate: string) => {
    setError(null)
    try {
      await updateSettings({ experimental: { ...experimental, tinyVmTemplate } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <SettingsSection title={m.settings_experimental()} description={m.settings_experimental_hint()}>
      <SettingsGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="settings-experimental-tiny-vm">{m.settings_tiny_vm()}</FieldLabel>
            <FieldDescription>{m.settings_tiny_vm_hint()}</FieldDescription>
          </FieldContent>
          <Switch
            id="settings-experimental-tiny-vm"
            checked={experimental.tinyVm}
            onCheckedChange={(checked) => void setTinyVm(checked)}
          />
        </Field>
        {experimental.tinyVm && <VmHost />}
        {experimental.tinyVm && (
          <VmTemplateField value={experimental.tinyVmTemplate} onChange={(name) => void setTemplate(name)} />
        )}
        {experimental.tinyVm && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="settings-experimental-tiny-vm-profile">{m.settings_tiny_vm_profile()}</FieldLabel>
              <FieldDescription>{m.settings_tiny_vm_profile_hint()}</FieldDescription>
            </FieldContent>
            <Switch
              id="settings-experimental-tiny-vm-profile"
              checked={experimental.tinyVmProfile}
              onCheckedChange={(checked) => void setProfile(checked)}
            />
          </Field>
        )}
        {experimental.tinyVm && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="settings-experimental-tiny-vm-passkeys">{m.settings_tiny_vm_passkeys()}</FieldLabel>
              <FieldDescription>{m.settings_tiny_vm_passkeys_hint()}</FieldDescription>
            </FieldContent>
            <Switch
              id="settings-experimental-tiny-vm-passkeys"
              checked={experimental.tinyVmPasskeys}
              onCheckedChange={(checked) => void setPasskeys(checked)}
            />
          </Field>
        )}
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
    </SettingsSection>
  )
}

/** The template new tiny VMs restore from, offered once the host lists its templates. */
function VmTemplateField({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const environment = useSettingsEnvironment()
  const host = useAtomValue(vmHostAtom(environment))
  const templates: ReadonlyArray<VmTemplate> =
    AsyncResult.isSuccess(host) && host.value.status === "connected" ? host.value.templates : []
  if (templates.length === 0) return null
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="settings-experimental-tiny-vm-template">{m.settings_tiny_vm_template()}</FieldLabel>
        <FieldDescription>{m.settings_tiny_vm_template_hint()}</FieldDescription>
      </FieldContent>
      <VmTemplateSelect
        id="settings-experimental-tiny-vm-template"
        templates={templates}
        value={value}
        onChange={onChange}
      />
    </Field>
  )
}

/** Whether hinacode reaches the sbx host, through the login `sbx login` wrote. */
function VmHost() {
  const environment = useSettingsEnvironment()
  const host = useAtomValue(vmHostAtom(environment))
  const refresh = useAtomRefresh(vmHostAtom(environment))
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
          .onSuccess((status) => <HostStatus status={status} />)
          .onError((cause) => <span className="text-destructive">{errorMessage(cause)}</span>)
          .orElse(() => null)}
      </p>
      {AsyncResult.isSuccess(host) && host.value.status === "connected" ? null : checkAgain}
    </div>
  )
}

/** Renders the `backticked` spans of a translated sentence as code, so translators keep one sentence. */
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
          {m.settings_tiny_vm_connected({
            host: hostOf(status.url),
            sandboxes: String(status.sandboxes),
            max: String(status.maxSandboxes),
          })}
        </>
      )
    case "notConfigured":
      return <span className="text-muted-foreground">{withCode(m.settings_tiny_vm_not_configured())}</span>
    case "unreachable":
      return (
        <span className="text-destructive">
          {m.settings_tiny_vm_unreachable({ url: status.url, message: status.message })}
        </span>
      )
  }
}

/** "http://192.168.1.10:7070/" reads as "192.168.1.10:7070". */
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
