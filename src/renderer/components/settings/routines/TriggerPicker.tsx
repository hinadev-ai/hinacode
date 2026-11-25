import { useId } from "react"
import { m } from "../../../paraglide/messages.js"
import { Input } from "../../ui/input.tsx"
import { Label } from "../../ui/label.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select.tsx"
import { Switch } from "../../ui/switch.tsx"
import { isTriggerEvent, type TriggerDraft, triggerEventLabel, triggerEvents } from "./trigger.ts"

const NO_TRIGGER = "none"
const labelClass = "font-normal text-muted-foreground"

interface TriggerPickerProps {
  readonly value: TriggerDraft
  readonly onChange: (value: TriggerDraft) => void
}

export function TriggerPicker({ value, onChange }: TriggerPickerProps) {
  const id = useId()
  const patch = (next: Partial<TriggerDraft>) => onChange({ ...value, ...next })
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
      {value.event !== null && (
        <>
          <Label htmlFor={`${id}-from`} className={labelClass}>
            {m.routines_trigger_from_label()}
          </Label>
          <Input
            id={`${id}-from`}
            required
            value={value.fromUsers}
            onChange={(event) => patch({ fromUsers: event.target.value })}
            placeholder="octocat, hubot"
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono"
          />
          <Label htmlFor={`${id}-scopes`} className={labelClass}>
            {m.routines_trigger_scopes_label()}
          </Label>
          <Input
            id={`${id}-scopes`}
            value={value.scopes}
            onChange={(event) => patch({ scopes: event.target.value })}
            placeholder="acme/api"
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono"
          />
          <Label htmlFor={`${id}-contains`} className={labelClass}>
            {m.routines_trigger_contains_label()}
          </Label>
          <Input
            id={`${id}-contains`}
            value={value.contains}
            onChange={(event) => patch({ contains: event.target.value })}
            placeholder="@hina"
            autoComplete="off"
            className="h-8"
          />
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
