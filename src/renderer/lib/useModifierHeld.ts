import { useSyncExternalStore } from "react"

let held = false
const listeners = new Set<() => void>()

const update = (next: boolean) => {
  if (next === held) return
  held = next
  for (const listener of listeners) listener()
}

const onKey = (event: KeyboardEvent) => update(event.metaKey || event.ctrlKey)
const onBlur = () => update(false)

const subscribe = (listener: () => void) => {
  if (listeners.size === 0) {
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKey)
    window.addEventListener("blur", onBlur)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    window.removeEventListener("keydown", onKey)
    window.removeEventListener("keyup", onKey)
    window.removeEventListener("blur", onBlur)
    held = false
  }
}

export const useModifierHeld = () => useSyncExternalStore(subscribe, () => held)
