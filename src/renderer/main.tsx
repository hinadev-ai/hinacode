import "./index.css"
import { RegistryContext } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { StrictMode, useEffect, useLayoutEffect } from "react"
import { createRoot } from "react-dom/client"
import { DockBadge } from "./components/DockBadge.tsx"
import { Toaster } from "./components/ui/sonner.tsx"
import { TooltipProvider } from "./components/ui/tooltip.tsx"
import { applyAppearance, themes, useTheme } from "./lib/appearance.ts"
import { registry } from "./lib/registry.ts"
import { callPromise, clientSettingsAtom, onPushEvent, projectsAtom, settingsAtom } from "./lib/rpc.ts"
import { terminalExited, writeTerminal } from "./lib/terminalScreens.ts"
import { useClientSettings } from "./lib/settings.ts"
import { notifyThreadEvent, recordUnseenOutcome } from "./lib/threadNotifications.ts"
import { router } from "./router.tsx"
import { useBackgroundTasks } from "./stores/backgroundTasks.ts"
import { useLocale } from "./stores/locale.ts"
import { useMessages } from "./stores/messages.ts"
import { usePullRequestGuides } from "./stores/pullRequestGuides.ts"
import { loadAllPullRequestsAtom, usePullRequests } from "./stores/pullRequests.ts"
import { useSubagents } from "./stores/subagents.ts"
import { useTerminals } from "./stores/terminals.ts"
import { useThreads } from "./stores/threads.ts"
import { useUnseen } from "./stores/unseen.ts"
import { useWorktrees } from "./stores/worktrees.ts"

if (window.hinacode.liquidGlass) document.documentElement.dataset.glass = ""

function App() {
  const locale = useLocale((state) => state.locale)
  const { appearance } = useClientSettings()
  const theme = useTheme(appearance.theme)
  useLayoutEffect(() => applyAppearance(appearance, theme.scheme), [appearance, theme.scheme])
  const nativeScheme = themes[appearance.theme].scheme
  useEffect(() => {
    void callPromise("app.setColorScheme", nativeScheme)
  }, [nativeScheme])
  useLayoutEffect(() => {
    void callPromise("app.ready", undefined)
  }, [])
  // Remount on locale change so every message function runs again; router and atoms live outside.
  return (
    <TooltipProvider key={locale}>
      <RouterProvider router={router} />
      <DockBadge />
      {/* Below the 3rem header and clear of the side panel's activity bar, so no control is covered. */}
      <Toaster position="top-right" offset={{ top: "3.5rem", right: "3.5rem" }} theme={theme.scheme} />
    </TooltipProvider>
  )
}

/** Threads and worktrees of every environment, which main merges into one list each. */
async function loadLists() {
  // Each list replaces its store as soon as it answers, so a push that arrives after it is not undone by a later answer.
  await Promise.all([
    callPromise("threads.list", undefined).then(useThreads.getState().replaceAll),
    callPromise("worktrees.list", undefined).then(useWorktrees.getState().replaceAll),
  ])
}

onPushEvent((event) => {
  switch (event.type) {
    case "thread.updated":
      return useThreads.getState().upsert(event.thread)
    case "thread.removed":
      useUnseen.getState().clear(event.id)
      return useThreads.getState().remove(event.id)
    case "message.created":
    case "message.updated":
      return useMessages.getState().receive(event)
    case "thread.event": {
      useMessages.getState().receive(event)
      recordUnseenOutcome(event.threadId, event.event)
      const settings = AsyncResult.getOrElse(registry.get(clientSettingsAtom), () => null)
      return settings && notifyThreadEvent(event.threadId, event.event, settings.notifications)
    }
    case "worktree.updated":
      return useWorktrees.getState().upsert(event.worktree)
    case "worktree.setupLog":
      return useWorktrees.getState().appendSetupLog(event.id, event.chunk)
    case "thread.pullRequests":
      return usePullRequests.getState().replace(event.threadId, event.links)
    case "pullRequest.guide":
      return usePullRequestGuides.getState().replace(event.url, event.state)
    case "thread.subagents":
      return useSubagents.getState().replace(event.threadId, event.subagents)
    case "thread.backgroundTasks":
      return useBackgroundTasks.getState().replace(event.threadId, event.tasks)
    case "terminal.data":
      return writeTerminal(event.id, event.data, event.offset)
    case "terminal.exited":
      terminalExited(event.id, event.exitCode)
      return useTerminals.getState().markExited(event.id, event.exitCode)
    case "environment.status":
      // A cloud that connects fills its sidebar section from fresh lists.
      if (event.status !== "connected") return
      registry.refresh(projectsAtom)
      registry.refresh(loadAllPullRequestsAtom)
      reloadTranscripts(event.id)
      reattachTerminals(event.id)
      return void loadLists()
    case "environments.changed":
      // A cloud the relay dropped takes its projects and threads out of the sidebar.
      registry.refresh(projectsAtom)
      return void loadLists()
  }
})

const isOnCloud = (environmentId: string) => {
  const projects = AsyncResult.getOrElse(registry.get(projectsAtom), () => [])
  const onCloud = new Set(
    projects.filter((project) => project.environmentId === environmentId).map((project) => project.id),
  )
  const threads = useThreads.getState().byId
  return (threadId: string) => onCloud.has(threads[threadId]?.projectId ?? "")
}

/**
 * Pushes a cloud sent while its socket was down are gone, and a restarted cloud counts `seq` from zero again, so
 * every open transcript of that cloud is read again from a fresh snapshot.
 */
const reloadTranscripts = (environmentId: string) => {
  const onCloud = isOnCloud(environmentId)
  const { byThread, unload, load } = useMessages.getState()
  for (const threadId of Object.keys(byThread)) {
    if (!onCloud(threadId)) continue
    unload(threadId)
    void load(threadId)
  }
}

const reattachTerminals = (environmentId: string) => {
  const onCloud = isOnCloud(environmentId)
  const { byThreadId, attach } = useTerminals.getState()
  for (const [threadId, terminals] of Object.entries(byThreadId)) {
    if (onCloud(threadId)) for (const session of terminals.sessions) void attach(session.id)
  }
}

// Subscribed above before anything loads: a push sent while a list is on its way, such as a setup script ending
// during a reload, would otherwise be lost and leave the store stale.
const [settings] = await Promise.all([
  Effect.runPromise(AtomRegistry.getResult(registry, clientSettingsAtom)),
  loadLists(),
  Effect.runPromise(Effect.ignore(AtomRegistry.getResult(registry, settingsAtom(null)))),
])
useLocale.getState().apply(settings.locale)
applyAppearance(settings.appearance)
const root = document.getElementById("root")
if (!root) throw new Error("#root is missing from index.html")

createRoot(root).render(
  <StrictMode>
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>
  </StrictMode>,
)
