import type { ReactNode } from "react"
import type { BoatMachineCreate, BoatMachineOptions, BoatVmSize } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { Field, FieldContent, FieldDescription, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"
import { Switch } from "./ui/switch.tsx"
import { Textarea } from "./ui/textarea.tsx"

export type ConfiguredBoatOptions = Extract<BoatMachineOptions, { configured: true }>

export interface BoatSpec {
  readonly type: BoatVmSize
  readonly from: string
  readonly shareCode: string
  readonly environment: string
  readonly hours: string
  readonly neverStop: boolean
  readonly noEnv: boolean
  readonly snapshots: boolean
  readonly monitoring: boolean
  readonly setupScript: string
}

const SIZES: ReadonlyArray<{ readonly value: BoatVmSize; readonly cpus: number; readonly memory: number }> = [
  { value: "small", cpus: 2, memory: 4 },
  { value: "default", cpus: 4, memory: 8 },
  { value: "large", cpus: 8, memory: 16 },
  { value: "xlarge", cpus: 16, memory: 32 },
]

const isSize = (value: unknown): value is BoatVmSize => SIZES.some((size) => size.value === value)

export const newBoatSpec = (options: ConfiguredBoatOptions, hours: number): BoatSpec => ({
  type: "small",
  from: "",
  shareCode: "",
  environment: options.environments.find((environment) => environment.isDefault)?.name ?? "",
  hours: String(hours),
  neverStop: false,
  noEnv: false,
  snapshots: true,
  monitoring: true,
  setupScript: "",
})

const validHours = (spec: BoatSpec) => {
  const hours = Number(spec.hours)
  return Number.isInteger(hours) && hours >= 1 && hours <= 720 ? hours : null
}

export const boatCreateOf = (spec: BoatSpec, name: string): BoatMachineCreate | null => {
  const hours = validHours(spec)
  if (!spec.neverStop && hours === null) return null
  return {
    name,
    type: spec.type,
    from: spec.shareCode.trim() || spec.from,
    environment: spec.environment,
    autoStopHours: spec.neverStop ? null : hours,
    noEnv: spec.noEnv,
    snapshots: spec.snapshots,
    monitoring: spec.monitoring,
    setupScript: spec.setupScript,
  }
}

export function BoatSpecFields({
  idPrefix,
  options,
  spec,
  onChange,
}: {
  idPrefix: string
  options: ConfiguredBoatOptions
  spec: BoatSpec
  onChange: (next: BoatSpec) => void
}) {
  const patch = (next: Partial<BoatSpec>) => onChange({ ...spec, ...next })
  const hoursValid = spec.neverStop || validHours(spec) !== null
  const fromItems = [
    { value: "", label: m.boat_machine_fresh_sandbox() },
    ...options.snapshots.map((name) => ({ value: name, label: name })),
  ]

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-type`}>{m.boat_machine_type()}</FieldLabel>
        <PlainSelect
          id={`${idPrefix}-type`}
          items={SIZES.map((size) => ({
            value: size.value,
            label: m.boat_machine_size({ name: size.value, cpus: String(size.cpus), memory: String(size.memory) }),
          }))}
          value={spec.type}
          onChange={(value) => isSize(value) && patch({ type: value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-from`}>{m.boat_machine_from()}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <PlainSelect
            id={`${idPrefix}-from`}
            items={fromItems}
            value={spec.from}
            onChange={(value) => patch({ from: value })}
          />
          <Input
            aria-label={m.boat_machine_share_code()}
            value={spec.shareCode}
            onChange={(event) => patch({ shareCode: event.target.value })}
            placeholder={m.boat_machine_share_code()}
            spellCheck={false}
            autoComplete="off"
            className="w-64 font-mono"
          />
        </div>
      </Field>
      {options.environments.length > 0 && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-environment`}>{m.boat_machine_environment()}</FieldLabel>
          <PlainSelect
            id={`${idPrefix}-environment`}
            items={options.environments.map(({ name }) => ({ value: name, label: name }))}
            value={spec.environment}
            onChange={(value) => patch({ environment: value })}
          />
        </Field>
      )}
      <Field data-invalid={!hoursValid || undefined}>
        <FieldLabel htmlFor={`${idPrefix}-hours`}>{m.boat_machine_auto_stop()}</FieldLabel>
        <span className="flex items-center gap-2 text-sm">
          <Input
            id={`${idPrefix}-hours`}
            type="number"
            min={1}
            max={720}
            step={1}
            value={spec.hours}
            disabled={spec.neverStop}
            onChange={(event) => patch({ hours: event.target.value })}
            aria-invalid={!hoursValid || undefined}
            className="w-24"
          />
          {m.boat_machine_hours()}
        </span>
      </Field>
      <ToggleField
        id={`${idPrefix}-never-stop`}
        label={m.boat_machine_never_stop()}
        checked={spec.neverStop}
        onCheckedChange={(checked) => patch({ neverStop: checked })}
      />
      <ToggleField
        id={`${idPrefix}-no-env`}
        label={m.boat_machine_no_env()}
        hint={m.boat_machine_no_env_hint()}
        checked={spec.noEnv}
        onCheckedChange={(checked) => patch({ noEnv: checked })}
      />
      <ToggleField
        id={`${idPrefix}-snapshots-off`}
        label={m.boat_machine_snapshots_off()}
        hint={m.boat_machine_snapshots_off_hint()}
        checked={!spec.snapshots}
        onCheckedChange={(checked) => patch({ snapshots: !checked })}
      />
      <ToggleField
        id={`${idPrefix}-monitoring-off`}
        label={m.boat_machine_monitoring_off()}
        checked={!spec.monitoring}
        onCheckedChange={(checked) => patch({ monitoring: !checked })}
      />
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-setup`}>{m.boat_machine_setup()}</FieldLabel>
        <Textarea
          id={`${idPrefix}-setup`}
          rows={3}
          value={spec.setupScript}
          onChange={(event) => patch({ setupScript: event.target.value })}
          placeholder={"#!/bin/bash\nnpm install"}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </Field>
    </>
  )
}

export function PlainSelect({
  id,
  items,
  value,
  onChange,
}: {
  id: string
  items: ReadonlyArray<{ readonly value: string; readonly label: string }>
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select items={items} value={value} onValueChange={(next) => typeof next === "string" && onChange(next)}>
      <SelectTrigger id={id} className="max-w-full min-w-48">
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
  )
}

function ToggleField({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint !== undefined && <FieldDescription>{hint}</FieldDescription>}
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  )
}
