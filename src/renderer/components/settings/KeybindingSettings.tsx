import { useAtomSet } from "@effect/atom-react"
import { type KeyboardEvent, useState } from "react"
import { RiErrorWarningLine } from "react-icons/ri"
import { chordFromEvent } from "../../keybindings/chord.ts"
import { type Command, commands, conflictsOf } from "../../keybindings/commands.ts"
import { useKeymap } from "../../keybindings/useKeybindings.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { ChordKeys } from "../ChordKeys.tsx"
import { Button } from "../ui/button.tsx"
import { FieldError } from "../ui/field.tsx"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.tsx"
import { SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"

export function KeybindingSettings() {
  const { keybindings: overrides } = useSettings()
  const keymap = useKeymap()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const saveOverrides = async (next: Record<string, string>) => {
    setError(null)
    try {
      await updateSettings({ keybindings: next })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const bind = (command: Command, chord: string) => {
    const { [command.id]: _previous, ...rest } = overrides
    // Only overrides are stored, so picking the default again drops the override.
    void saveOverrides(chord === command.defaultKeys ? rest : { ...rest, [command.id]: chord })
  }

  const reset = (command: Command) => {
    const { [command.id]: _removed, ...rest } = overrides
    void saveOverrides(rest)
  }

  return (
    <SettingsSection
      title={m.settings_keybindings()}
      description={m.settings_keybindings_hint()}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => void saveOverrides({})}
        >
          {m.settings_keybindings_reset_all()}
        </Button>
      }
    >
      {error && <FieldError>{error}</FieldError>}
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-2/5">{m.settings_keybindings_command()}</TableHead>
            <TableHead>{m.settings_keybindings_shortcut()}</TableHead>
            <TableHead className="w-36 text-right">
              <span className="sr-only">{m.settings_keybindings_actions()}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {commands.map((command) => (
            <KeybindingRow
              key={command.id}
              command={command}
              chord={keymap[command.id] ?? ""}
              conflicts={conflictsOf(keymap, command.id)}
              overridden={command.id in overrides}
              recording={recordingId === command.id}
              onRecord={() => setRecordingId(command.id)}
              onRecordEnd={() => setRecordingId(null)}
              onBind={(chord) => bind(command, chord)}
              onReset={() => reset(command)}
            />
          ))}
        </TableBody>
      </Table>
    </SettingsSection>
  )
}

interface KeybindingRowProps {
  readonly command: Command
  readonly chord: string
  readonly conflicts: ReadonlyArray<Command>
  readonly overridden: boolean
  readonly recording: boolean
  readonly onRecord: () => void
  readonly onRecordEnd: () => void
  readonly onBind: (chord: string) => void
  readonly onReset: () => void
}

function KeybindingRow(props: KeybindingRowProps) {
  const { command, chord, conflicts, overridden, recording, onRecord, onRecordEnd, onBind, onReset } = props
  const title = command.title()

  const captureChord = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return
    // Plain Tab still moves focus, which ends recording, so keyboard users are never trapped.
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return
    event.preventDefault()
    // Keep the window-level keybindings from running the chord being recorded.
    event.stopPropagation()
    if (event.key === "Escape") return onRecordEnd()
    const recorded = chordFromEvent(event.nativeEvent)
    if (!recorded) return
    onRecordEnd()
    onBind(recorded)
  }

  return (
    <TableRow data-recording={recording || undefined} className="data-recording:bg-muted/50">
      <TableCell className="font-medium whitespace-normal">{title}</TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          {recording ? (
            <span className="text-sm text-muted-foreground">{m.settings_keybindings_recording()}</span>
          ) : chord ? (
            <ChordKeys chord={chord} />
          ) : (
            <span className="text-sm text-muted-foreground">{m.settings_keybindings_unbound()}</span>
          )}
          {conflicts.length > 0 && (
            <p className="flex items-start gap-1 text-xs whitespace-normal text-destructive">
              <RiErrorWarningLine aria-hidden className="mt-px shrink-0" />
              {m.settings_keybindings_conflict({ commands: conflicts.map((other) => other.title()).join(", ") })}
            </p>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button
            variant={recording ? "secondary" : "outline"}
            size="xs"
            aria-label={m.settings_keybindings_record_for({ command: title })}
            aria-pressed={recording}
            onClick={onRecord}
            onKeyDown={captureChord}
            onBlur={() => recording && onRecordEnd()}
          >
            {m.settings_keybindings_record()}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={m.settings_keybindings_reset_for({ command: title })}
            disabled={!overridden}
            onClick={onReset}
          >
            {m.settings_keybindings_reset()}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
