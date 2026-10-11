import "./index.css"
import { RegistryContext } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { TooltipProvider } from "./components/ui/tooltip.tsx"
import { callPromise, onPushEvent, settingsAtom } from "./lib/rpc.ts"
import { router } from "./router.tsx"
import { useLocale } from "./stores/locale.ts"
import { useMessages } from "./stores/messages.ts"
import { useThreads } from "./stores/threads.ts"
import { useWorktrees } from "./stores/worktrees.ts"

const registry = AtomRegistry.make()

function App() {
  const locale = useLocale((state) => state.locale)
  // Remount on locale change so every message function runs again; router and atoms live outside.
  return (
    <TooltipProvider key={locale}>
      <RouterProvider router={router} />
    </TooltipProvider>
  )
}

const [settings, threads, worktrees] = await Promise.all([
  Effect.runPromise(AtomRegistry.getResult(registry, settingsAtom)),
  callPromise("threads.list", undefined),
  callPromise("worktrees.list", undefined),
])
useLocale.getState().apply(settings.locale)
useThreads.getState().replaceAll(threads)
useWorktrees.getState().replaceAll(worktrees)
onPushEvent((event) => {
  switch (event.type) {
    case "thread.updated":
      return useThreads.getState().upsert(event.thread)
    case "message.created":
      return useMessages.getState().addMessage(event.message)
    case "message.updated":
      return useMessages.getState().updateMessage(event.message)
    case "thread.event":
      return useMessages.getState().applyEvent(event.threadId, event.event)
    case "worktree.updated":
      return useWorktrees.getState().upsert(event.worktree)
    case "worktree.setupLog":
      return useWorktrees.getState().appendSetupLog(event.id, event.chunk)
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
