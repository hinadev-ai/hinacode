import { useSyncExternalStore } from "react"

const tickMs = 30_000
const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (timer === undefined) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, tickMs)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    clearInterval(timer)
    timer = undefined
  }
}

const getSnapshot = () => now

/** The current time in ms, shared by every caller and refreshed every 30 seconds while anything is subscribed. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot)
}
