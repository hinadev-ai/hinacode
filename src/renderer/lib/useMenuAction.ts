import { useRef } from "react"

/**
 * Base UI returns focus to the trigger as the menu closes, so opening a dialog directly from an item loses focus.
 */
export function useMenuAction<A>(run: (action: A) => void) {
  const queued = useRef<{ readonly action: A } | null>(null)
  return {
    queue: (action: A) => {
      queued.current = { action }
    },
    onOpenChangeComplete: (open: boolean) => {
      if (open) return
      const pending = queued.current
      queued.current = null
      if (pending !== null) run(pending.action)
    },
  }
}
