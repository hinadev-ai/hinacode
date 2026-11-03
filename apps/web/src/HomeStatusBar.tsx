import { useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button.tsx"
import { m } from "@/paraglide/messages.js"
import type { HomeStatus } from "./bridge.ts"

export const makeHomeStatus = () => {
  let current: HomeStatus = { status: "connecting", error: null }
  const listeners = new Set<() => void>()
  return {
    set: (next: HomeStatus) => {
      current = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => current,
  }
}

export type HomeStatusStore = ReturnType<typeof makeHomeStatus>

export function HomeStatusBar({
  store,
  machine,
  onSwitch,
}: {
  readonly store: HomeStatusStore
  readonly machine: string
  readonly onSwitch: () => void
}) {
  const { status, error } = useSyncExternalStore(store.subscribe, store.get)
  if (status === "connected") return null
  const refused = status === "unauthorized" || status === "incompatible"
  return (
    <output className="fixed inset-x-0 top-2 z-50 mx-auto flex w-fit max-w-[calc(100%-1rem)] items-center gap-3 rounded-full bg-popover py-1.5 ps-4 pe-1.5 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10">
      <span className="truncate">
        {refused ? (error ?? m.web_machine_refused({ machine })) : m.web_reconnecting({ machine })}
      </span>
      <Button size="sm" variant="ghost" className="rounded-full" onClick={onSwitch}>
        {m.web_switch_machine()}
      </Button>
    </output>
  )
}
