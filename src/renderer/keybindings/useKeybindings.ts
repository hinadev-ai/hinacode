import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useEffectEvent, useMemo } from "react"
import { tinykeys } from "tinykeys"
import { projectsAtom, updateSettingsAtom } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { toTinykeys } from "./chord.ts"
import { type Command, commands, resolveKeymap } from "./commands.ts"

const EDITABLE = "input, textarea, select, [contenteditable]"

/**
 * tinykeys ignores every key typed into a field by default. App shortcuts carry a modifier, so let
 * modified chords through and keep bare keys (typing) out.
 */
const ignore = (event: KeyboardEvent) => {
  if (event.repeat || event.isComposing) return true
  const typing = event.target instanceof Element && event.target.closest(EDITABLE) !== null
  return typing && !(event.ctrlKey || event.metaKey || event.altKey)
}

/** The user's effective keymap: command id -> canonical chord, "" when unbound. */
export const useKeymap = () => {
  const { keybindings } = useSettings()
  return useMemo(() => resolveKeymap(keybindings), [keybindings])
}

/** Binds every command to its effective chord on window. Mount once, in the app shell. */
export function useKeybindings() {
  const keymap = useKeymap()
  const navigate = useNavigate()
  const { threadId } = useParams({ strict: false })
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })

  const run = useEffectEvent((command: Command) =>
    command.run({ navigate, threadId: threadId ?? null, projects, updateSettings }),
  )

  useEffect(() => {
    const bindings = Object.fromEntries(
      commands
        .filter((command) => keymap[command.id])
        .map((command) => [
          toTinykeys(keymap[command.id] ?? ""),
          (event: KeyboardEvent) => {
            event.preventDefault()
            run(command)
          },
        ]),
    )
    return tinykeys(window, bindings, { ignore })
  }, [keymap])
}
