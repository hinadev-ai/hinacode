import { getHotkeyManager, matchesKeyboardEvent } from "@tanstack/react-hotkeys"
import { type RefObject, useEffect } from "react"

const ATTRIBUTE = "data-terminal-scope"

const hasCommandModifier = (event: KeyboardEvent) => event.ctrlKey || event.metaKey

/**
 * Marks the element as owning plain keys, for a terminal or anything else that needs every keystroke.
 *
 * Inside it, keys without Control or Meta (plain keys, Shift and Alt combos, Escape) never run an app
 * command and are left untouched, even if the user bound one of them. Control and Meta chords still
 * run app commands, as long as the element lets the keydown bubble to `document`. xterm consumes
 * the keys it handles, so return `false` from its `attachCustomKeyEventHandler` when
 * `isAppChord(event)` is true.
 */
export function useTerminalScope(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.setAttribute(ATTRIBUTE, "")
    return () => element.removeAttribute(ATTRIBUTE)
  }, [ref])
}

/** Whether a terminal scope owns this keydown, so app commands must leave it alone. */
export const isTerminalKey = (event: KeyboardEvent) =>
  !hasCommandModifier(event) && event.target instanceof Element && event.target.closest(`[${ATTRIBUTE}]`) !== null

/** Whether a keydown in a terminal scope would run an app command, so the terminal should let it bubble. */
export const isAppChord = (event: KeyboardEvent) =>
  hasCommandModifier(event) &&
  [...getHotkeyManager().registrations.state.values()].some(
    (registration) => registration.options.enabled !== false && matchesKeyboardEvent(event, registration.parsedHotkey),
  )
