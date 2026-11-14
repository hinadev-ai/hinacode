import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, type ReactNode, useState, useTransition } from "react"
import type { Environment } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { boatMachineOptionsAtom, connectBoatMachineAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useUi } from "../../stores/ui.ts"
import {
  boatCreateOf,
  BoatSpecFields,
  type ConfiguredBoatOptions,
  newBoatSpec,
  PlainSelect,
} from "../BoatSpecFields.tsx"
import { Button } from "../ui/button.tsx"
import { Field, FieldError, FieldGroup, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { SecretField } from "./IntegrationSettings.tsx"
import { settingsSurfaceClass } from "./SettingsSection.tsx"

const NEW_SANDBOX = "new"

export function BoatOptions({ children }: { children: (options: ConfiguredBoatOptions) => ReactNode }) {
  const options = useAtomValue(boatMachineOptionsAtom)
  return AsyncResult.builder(options)
    .onInitial(() => <p className="text-sm text-muted-foreground">{m.boat_machine_loading()}</p>)
    .onFailure((cause) => <FieldError>{errorMessage(Cause.squash(cause))}</FieldError>)
    .onSuccess((value) =>
      value.configured ? (
        children(value)
      ) : (
        <SecretField
          name="boat.apiKey"
          label={m.settings_boat_key_label()}
          placeholder={m.settings_boat_key_placeholder()}
          hint={m.boat_machine_key_hint()}
        />
      ),
    )
    .render()
}

export function BoatMachineForm() {
  return (
    <section aria-labelledby="environment-boat-title" className={cn(settingsSurfaceClass, "flex flex-col gap-4 p-4")}>
      <h3 id="environment-boat-title" className="text-sm font-medium">
        {m.boat_machine_title()}
      </h3>
      <BoatOptions>{(options) => <BoatMachineFields options={options} />}</BoatOptions>
    </section>
  )
}

function BoatMachineFields({ options }: { options: ConfiguredBoatOptions }) {
  const connect = useAtomSet(connectBoatMachineAtom, { mode: "promise" })
  const setAddProjectOpen = useUi((state) => state.setAddProjectOpen)
  const [sandbox, setSandbox] = useState(NEW_SANDBOX)
  const [name, setName] = useState("")
  const [spec, setSpec] = useState(() => newBoatSpec(options, 1))
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<Environment | null>(null)
  const [pending, startConnect] = useTransition()
  const creating = sandbox === NEW_SANDBOX
  const create = boatCreateOf(spec, name)

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (creating && create === null) return
    startConnect(async () => {
      setError(null)
      setAdded(null)
      try {
        setAdded(await connect({ sandbox: creating && create !== null ? { create } : { id: sandbox } }))
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  const sandboxItems = [
    { value: NEW_SANDBOX, label: m.boat_machine_new_sandbox() },
    ...options.sandboxes.map((item) => ({ value: item.id, label: `${item.name || item.id} (${item.state})` })),
  ]

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="boat-machine-sandbox">{m.boat_machine_sandbox()}</FieldLabel>
          <PlainSelect id="boat-machine-sandbox" items={sandboxItems} value={sandbox} onChange={setSandbox} />
        </Field>
        {creating && (
          <>
            <Field>
              <FieldLabel htmlFor="boat-machine-name">{m.environment_name_label()}</FieldLabel>
              <Input
                id="boat-machine-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="w-64"
              />
            </Field>
            <BoatSpecFields idPrefix="boat-machine" options={options} spec={spec} onChange={setSpec} />
          </>
        )}
      </FieldGroup>
      {error && <FieldError className="whitespace-pre-wrap">{error}</FieldError>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={pending || (creating && create === null)}>
          {pending ? m.boat_machine_setting_up() : creating ? m.boat_machine_create() : m.boat_machine_connect()}
        </Button>
        <output className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          {added && (
            <>
              <span>{m.environment_added({ name: added.name })}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setAddProjectOpen(true, added.id)}>
                {m.environment_add_project_on({ name: added.name })}
              </Button>
            </>
          )}
        </output>
      </div>
    </form>
  )
}
