import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Hotkey, matchesKeyboardEvent, useHotkeys } from "@tanstack/react-hotkeys"
import { useNavigate, useParams, useRouter } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useEffectEvent } from "react"
import { projectsAtom, updateClientSettingsAtom } from "../lib/rpc.ts"
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

export const useKeymap = (): Keymap => {
  const { keybindings } = useClientSettings()
  return resolveKeymap(keybindings)
}

const bindings = (keymap: Keymap, experimental: ExperimentalSettings) =>
  commands.reduce<Array<{ hotkey: Hotkey; command: Command }>>((bound, command) => {
    if (!isCommandAvailable(command, experimental)) return bound
    const hotkey = keymap[command.id]
    if (hotkey && !bound.some((binding) => sameChord(binding.hotkey, hotkey))) bound.push({ hotkey, command })
    return bound
  }, [])

export const useCommandContext = (): CommandContext => {
  const navigate = useNavigate()
  const { history } = useRouter()
  const { threadId = null } = useParams({ strict: false })
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const updateClientSettings = useAtomSet(updateClientSettingsAtom, { mode: "promise" })
  const { experimental } = useSettings(useThreadEnvironment(threadId))
  return { navigate, history, threadId, projects, updateClientSettings, experimental }
}

const runFromKeydown = (command: Command, event: KeyboardEvent, ctx: CommandContext) => {
  if (!whenHolds(command.when, { terminalFocus: isInTerminal(event.target) })) return false
  event.preventDefault()
  if (!event.repeat) command.run(ctx)
  return true
}

export function useKeybindings() {
  const keymap = useKeymap()
  const ctx = useCommandContext()
  const bound = bindings(keymap, ctx.experimental)

  useHotkeys(
    bound.map(({ hotkey, command }) => ({ hotkey, callback: (event) => runFromKeydown(command, event, ctx) })),
    { preventDefault: false, stopPropagation: false },
  )

  // FIXME: xterm stops the keydowns it handles, so bound chords are taken in the capture phase
  const takeFromTerminal = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || !(isInTerminal(event.target) || isInDeviceKeyboard(event.target))) return
    const binding = bound.find(({ hotkey }) => matchesKeyboardEvent(event, hotkey))
    if (binding && runFromKeydown(binding.command, event, ctx)) event.stopPropagation()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => takeFromTerminal(event)
    document.addEventListener("keydown", listener, { capture: true })
    return () => document.removeEventListener("keydown", listener, { capture: true })
  }, [])
}
