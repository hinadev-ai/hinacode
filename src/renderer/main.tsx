import "./index.css"
import { RegistryContext } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { StrictMode, useLayoutEffect } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "./components/ui/sonner.tsx"
import { TooltipProvider } from "./components/ui/tooltip.tsx"
import { applyAppearance, useTheme } from "./lib/appearance.ts"
import { callPromise, onPushEvent, settingsAtom } from "./lib/rpc.ts"
import { terminalExited, writeTerminal } from "./lib/terminalScreens.ts"
import { useSettings } from "./lib/settings.ts"
import { notifyThreadEvent } from "./lib/threadNotifications.ts"
import { router } from "./router.tsx"
import { useLocale } from "./stores/locale.ts"
import { useMessages } from "./stores/messages.ts"
import { usePullRequests } from "./stores/pullRequests.ts"
import { useSubagents } from "./stores/subagents.ts"
import { useTerminals } from "./stores/terminals.ts"
import { useThreads } from "./stores/threads.ts"
import { useWorktrees } from "./stores/worktrees.ts"

const registry = AtomRegistry.make()

function App() {
  const locale = useLocale((state) => state.locale)
  const { appearance } = useSettings()
  const theme = useTheme(appearance.theme)
  useLayoutEffect(() => applyAppearance(appearance, theme.scheme), [appearance, theme.scheme])
  useLayoutEffect(() => {
    void callPromise("app.ready", undefined)
  }, [])
  // Remount on locale change so every message function runs again; router and atoms live outside.
  return (
    <TooltipProvider key={locale}>
      <RouterProvider router={router} />
      {/* Below the 3rem header and clear of the side panel's activity bar, so no control is covered. */}
      <Toaster position="top-right" offset={{ top: "3.5rem", right: "3.5rem" }} theme={theme.scheme} />
    </TooltipProvider>
  )
}

const [settings, threads, worktrees] = await Promise.all([
  Effect.runPromise(AtomRegistry.getResult(registry, settingsAtom)),
  callPromise("threads.list", undefined),
  callPromise("worktrees.list", undefined),
])
useLocale.getState().apply(settings.locale)
applyAppearance(settings.appearance)
useThreads.getState().replaceAll(threads)
useWorktrees.getState().replaceAll(worktrees)
onPushEvent((event) => {
  switch (event.type) {
    case "thread.updated":
      return useThreads.getState().upsert(event.thread)
    case "message.created":
    case "message.updated":
      return useMessages.getState().receive(event)
    case "thread.event": {
      useMessages.getState().receive(event)
      const { notifications } = AsyncResult.getOrElse(registry.get(settingsAtom), () => settings)
      return notifyThreadEvent(event.threadId, event.event, notifications)
    }
    case "worktree.updated":
      return useWorktrees.getState().upsert(event.worktree)
    case "worktree.setupLog":
      return useWorktrees.getState().appendSetupLog(event.id, event.chunk)
    case "thread.pullRequests":
      return usePullRequests.getState().replace(event.threadId, event.links)
    case "thread.subagents":
      return useSubagents.getState().replace(event.threadId, event.subagents)
    case "terminal.data":
      return writeTerminal(event.id, event.data)
    case "terminal.exited":
      terminalExited(event.id, event.exitCode)
      return useTerminals.getState().markExited(event.id, event.exitCode)
  }
})

const root = document.getElementById("root")
if (!root) throw new Error("#root is missing from index.html")

createRoot(root).render(
  <StrictMode>
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>
  </StrictMode>,
)
