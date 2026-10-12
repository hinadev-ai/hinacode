import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Hotkey, useHotkeys } from "@tanstack/react-hotkeys"
import { useNavigate, useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useMemo } from "react"
import { projectsAtom, updateSettingsAtom } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { type Command, commands, type Keymap, resolveKeymap, sameChord } from "./commands.ts"
import { isTerminalKey } from "./terminalScope.ts"

/** The user's effective keymap: command id -> normalized chord, "" when unbound. */
export const useKeymap = (): Keymap => {
  const { keybindings } = useSettings()
  return useMemo(() => resolveKeymap(keybindings), [keybindings])
}

/**
 * One binding per chord, first command in registry order winning, so a chord bound twice runs one
 * command as the keybindings page warns.
 */
const bindings = (keymap: Keymap) =>
  commands.reduce<Array<{ hotkey: Hotkey; command: Command }>>((bound, command) => {
    const hotkey = keymap[command.id]
    if (hotkey && !bound.some((binding) => sameChord(binding.hotkey, hotkey))) bound.push({ hotkey, command })
    return bound
  }, [])

/**
 * Binds every command to its effective chord on document. Mount once, in the app shell. TanStack
 * Hotkeys skips plain keys typed into fields, lets Control and Meta chords fire there, and syncs
 * callbacks every render, so they read the current route.
 */
export function useKeybindings() {
  const keymap = useKeymap()
  const navigate = useNavigate()
  const { threadId } = useParams({ strict: false })
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })

  useHotkeys(
    bindings(keymap).map(({ hotkey, command }) => ({
      hotkey,
      callback: (event) => {
        if (isTerminalKey(event)) return
        event.preventDefault()
        if (!event.repeat) command.run({ navigate, threadId: threadId ?? null, projects, updateSettings })
      },
    })),
    // A terminal scope must get its keys untouched, so the default action is prevented only once it has passed.
    // Not requireReset: popups such as dialogs can swallow the keyup it waits for, which leaves the chord dead.
    { preventDefault: false, stopPropagation: false },
  )
}
