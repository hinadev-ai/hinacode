import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Hotkey, matchesKeyboardEvent, useHotkeys } from "@tanstack/react-hotkeys"
import { useNavigate, useParams, useRouter } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useEffectEvent } from "react"
import { onPushEvent, projectsAtom, updateClientSettingsAtom } from "../lib/rpc.ts"
import { useThreadEnvironment } from "../lib/environments.ts"
import { useClientSettings, useSettings } from "../lib/settings.ts"
import { isInDeviceKeyboard } from "../lib/elementPicker.ts"
import { isInTerminal } from "../lib/terminalScreens.ts"
import type { ExperimentalSettings } from "../../shared/domain.ts"
import {
  type Command,
  type CommandContext,
  commands,
  isCommandAvailable,
  type Keymap,
  resolveKeymap,
  sameChord,
  whenHolds,
} from "./commands.ts"

/** The user's effective keymap: command id -> normalized chord, "" when unbound. */
export const useKeymap = (): Keymap => {
  const { keybindings } = useClientSettings()
  return resolveKeymap(keybindings)
}

/**
 * One binding per chord, first command in registry order winning, so a chord bound twice runs one
 * command as the keybindings page warns.
 */
const bindings = (keymap: Keymap, experimental: ExperimentalSettings) =>
  commands.reduce<Array<{ hotkey: Hotkey; command: Command }>>((bound, command) => {
    if (!isCommandAvailable(command, experimental)) return bound
    const hotkey = keymap[command.id]
    if (hotkey && !bound.some((binding) => sameChord(binding.hotkey, hotkey))) bound.push({ hotkey, command })
    return bound
  }, [])

/** What a command needs from the current route and app state to run. */
export const useCommandContext = (): CommandContext => {
  const navigate = useNavigate()
  const { history } = useRouter()
  const { threadId = null } = useParams({ strict: false })
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const updateClientSettings = useAtomSet(updateClientSettingsAtom, { mode: "promise" })
  const { experimental } = useSettings(useThreadEnvironment(threadId))
  return { navigate, history, threadId, projects, updateClientSettings, experimental }
}

/** Runs the command if its `when` clause holds where the keydown happened. Returns whether it ran. */
const runFromKeydown = (command: Command, event: KeyboardEvent, ctx: CommandContext) => {
  if (!whenHolds(command.when, { terminalFocus: isInTerminal(event.target) })) return false
  event.preventDefault()
  if (!event.repeat) command.run(ctx)
  return true
}

/**
 * Binds every command to its effective chord on document, and runs the ones the native menu picks. Mount once, in the app shell. TanStack
 * Hotkeys skips plain keys typed into fields, lets Control and Meta chords fire there, and syncs
 * callbacks every render, so they read the current route.
 */
export function useKeybindings() {
  const keymap = useKeymap()
  const ctx = useCommandContext()
  const bound = bindings(keymap, ctx.experimental)

  useHotkeys(
    bound.map(({ hotkey, command }) => ({ hotkey, callback: (event) => runFromKeydown(command, event, ctx) })),
    // A chord whose `when` clause fails must keep its default action.
    // Not requireReset: popups such as dialogs can swallow the keyup it waits for, which leaves the chord dead.
    { preventDefault: false, stopPropagation: false },
  )

  // The terminal and a device screen send chords on and stop them, so they never bubble to the bindings above.
  // Like VS Code's commandsToSkipShell, a chord whose command runs there is taken before they see it.
  const takeFromTerminal = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || !(isInTerminal(event.target) || isInDeviceKeyboard(event.target))) return
    const binding = bound.find(({ hotkey }) => matchesKeyboardEvent(event, hotkey))
    if (binding && runFromKeydown(binding.command, event, ctx)) event.stopPropagation()
  })
  const runFromMenu = useEffectEvent((id: string) => commands.find((command) => command.id === id)?.run(ctx))
  useEffect(
    () =>
      onPushEvent((event) => {
        if (event.type === "menu.command") runFromMenu(event.command)
      }),
    [],
  )

  useEffect(() => {
    const listener = (event: KeyboardEvent) => takeFromTerminal(event)
    document.addEventListener("keydown", listener, { capture: true })
    return () => document.removeEventListener("keydown", listener, { capture: true })
  }, [])
}
