import { useEffect } from "react"
import { create } from "zustand"

const TICK_MS = 30_000

const useClock = create(() => ({ now: Date.now() }))

let watchers = 0
let timer: ReturnType<typeof setInterval> | undefined

/** The time, updated every 30 seconds by one timer shared by every component that shows a relative time. */
export function useNow() {
  useEffect(() => {
    watchers += 1
    if (watchers === 1) {
      useClock.setState({ now: Date.now() })
      timer = setInterval(() => useClock.setState({ now: Date.now() }), TICK_MS)
    }
    return () => {
      watchers -= 1
      if (watchers === 0) clearInterval(timer)
    }
  }, [])
  return useClock((state) => state.now)
}
