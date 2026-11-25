import { useId } from "react"
import { m } from "../../../paraglide/messages.js"
import { Input } from "../../ui/input.tsx"
import { Label } from "../../ui/label.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select.tsx"
import { Switch } from "../../ui/switch.tsx"
import {
  carriesSenderText,
  isTriggerEvent,
  type TriggerDraft,
  triggerEventLabel,
  triggerEvents,
  triggerFields,
  triggerSource,
} from "./trigger.ts"

const NO_TRIGGER = "none"
const labelClass = "font-normal text-muted-foreground"

interface TriggerPickerProps {
  readonly value: TriggerDraft
  readonly onChange: (value: TriggerDraft) => void
}

export function TriggerPicker({ value, onChange }: TriggerPickerProps) {
  const id = useId()
  const patch = (next: Partial<TriggerDraft>) => onChange({ ...value, ...next })
  const fields = value.event === null ? null : triggerFields[triggerSource(value.event)]
  const items = [
    { value: NO_TRIGGER, label: m.routines_trigger_none() },
    ...triggerEvents.map((event) => ({ value: event, label: triggerEventLabel[event]() })),
  ]

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
      <Label htmlFor={`${id}-event`} className={labelClass}>
        {m.routines_trigger_label()}
      </Label>
      <Select
        items={items}
        value={value.event ?? NO_TRIGGER}
        onValueChange={(next) => patch({ event: isTriggerEvent(next) ? next : null })}
      >
        <SelectTrigger id={`${id}-event`} className="w-fit max-w-full">
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {fields !== null && (
        <>
          <Label htmlFor={`${id}-from`} className={labelClass}>
            {fields.from.label()}
          </Label>
          <Input
            id={`${id}-from`}
            required
            value={value.fromUsers}
            onChange={(event) => patch({ fromUsers: event.target.value })}
            placeholder={fields.from.placeholder}
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono"
          />
          <Label htmlFor={`${id}-scopes`} className={labelClass}>
            {fields.scopes.label()}
          </Label>
          <Input
            id={`${id}-scopes`}
            value={value.scopes}
            onChange={(event) => patch({ scopes: event.target.value })}
            placeholder={fields.scopes.placeholder}
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono"
          />
          {value.event !== null && carriesSenderText(value.event) && (
            <>
              <Label htmlFor={`${id}-contains`} className={labelClass}>
                {m.routines_trigger_contains_label()}
              </Label>
              <Input
                id={`${id}-contains`}
                value={value.contains}
                onChange={(event) => patch({ contains: event.target.value })}
                placeholder={fields.containsPlaceholder}
                autoComplete="off"
                className="h-8"
              />
            </>
          )}
          {fields.hint !== null && <p className="col-start-2 text-xs text-muted-foreground">{fields.hint()}</p>}
          <Label className="col-span-2 font-normal">
            <Switch
              checked={value.continueConversation}
              onCheckedChange={(continueConversation) => patch({ continueConversation })}
            />
            {m.routines_trigger_continue_label()}
          </Label>
        </>
      )}
    </div>
  )
}
