import { useEffect } from "react"
import { createStore, useStore } from "zustand"

const clocks = new Map<number, ReturnType<typeof createClock>>()

function createClock(tickMs: number) {
  const store = createStore(() => ({ now: Date.now() }))
  let watchers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const watch = () => {
    watchers += 1
    if (watchers === 1) {
      store.setState({ now: Date.now() })
      timer = setInterval(() => store.setState({ now: Date.now() }), tickMs)
    }
    return () => {
      watchers -= 1
      if (watchers === 0) clearInterval(timer)
    }
  }
  return { store, watch }
}

function clock(tickMs: number) {
  const existing = clocks.get(tickMs)
  if (existing !== undefined) return existing
  const created = createClock(tickMs)
  clocks.set(tickMs, created)
  return created
}

/**
 * The time, updated every `tickMs` by one timer shared by every component that ticks at that rate. Relative times
 * use the default 30 seconds; a stopwatch passes 1000. A `paused` clock keeps the last time it read.
 */
export function useNow(tickMs = 30_000, { paused = false }: { readonly paused?: boolean } = {}) {
  const { store, watch } = clock(tickMs)
  useEffect(() => (paused ? undefined : watch()), [paused, watch])
  return useStore(store, (state) => state.now)
}
