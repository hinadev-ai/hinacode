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
import { useThreads } from "./stores/threads.ts"

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

const [settings, threads] = await Promise.all([
  Effect.runPromise(AtomRegistry.getResult(registry, settingsAtom)),
  callPromise("threads.list", undefined),
])
useLocale.getState().apply(settings.locale)
useThreads.getState().replaceAll(threads)
onPushEvent((event) => {
  if (event.type === "thread.updated") useThreads.getState().upsert(event.thread)
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
