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
import { errorMessage } from "./lib/errorMessage.ts"
import { openSidechat } from "./lib/sidechat.ts"
import { selectThread, useThreads } from "./stores/threads.ts"
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
  // FIXME: Paraglide messages read the locale when called, so the tree remounts on locale change
  return (
    <TooltipProvider key={locale}>
      <RouterProvider router={router} />
      <DockBadge />
      <Toaster position="top-right" offset={{ top: "3.5rem", right: "3.5rem" }} theme={theme.scheme} />
    </TooltipProvider>
  )
}

async function loadLists() {
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
      useMessages.getState().unload(event.id)
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
      if (event.status !== "connected") return
      registry.refresh(projectsAtom)
      registry.refresh(loadAllPullRequestsAtom)
      reloadTranscripts(event.id)
      refreshSidechats(event.id)
      reattachTerminals(event.id)
      return void loadLists()
    case "environments.changed":
      registry.refresh(projectsAtom)
      return void loadLists()
  }
})

const isOnCloud = (environmentId: string) => {
  const projects = AsyncResult.getOrElse(registry.get(projectsAtom), () => [])
  const onCloud = new Set(
    projects.filter((project) => project.environmentId === environmentId).map((project) => project.id),
  )
  const threads = useThreads.getState()
  return (threadId: string) => onCloud.has(selectThread(threadId)(threads)?.projectId ?? "")
}

const reloadTranscripts = (environmentId: string) => {
  const onCloud = isOnCloud(environmentId)
  const { byThread, reload } = useMessages.getState()
  for (const threadId of Object.keys(byThread)) {
    if (onCloud(threadId)) void reload(threadId)
  }
}

const refreshSidechats = (environmentId: string) => {
  const onCloud = isOnCloud(environmentId)
  for (const parentId of Object.keys(useThreads.getState().sidechats)) {
    if (onCloud(parentId))
      openSidechat(parentId).catch((cause: unknown) =>
        console.error(`Could not refresh a side chat: ${errorMessage(cause)}`),
      )
  }
}

const reattachTerminals = (environmentId: string) => {
  const onCloud = isOnCloud(environmentId)
  const { byThreadId, attach } = useTerminals.getState()
  for (const [threadId, terminals] of Object.entries(byThreadId)) {
    if (onCloud(threadId)) for (const session of terminals.sessions) void attach(session.id)
  }
}

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
