import { RiAddLine, RiFileTextLine } from "react-icons/ri"
import { ProviderIcon } from "../components/ProviderIcon.tsx"
import { commands } from "../keybindings/commands.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { startThread } from "../lib/startThread.ts"
import { m } from "../paraglide/messages.js"
import { emptyDraft, useDrafts } from "../stores/drafts.ts"
import { selectProjectThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import type { PaletteItem, PaletteSource } from "./types.ts"

const iconClass = "size-3.5 shrink-0 text-muted-foreground"

/** Threads in sidebar order. */
export const threadsSource: PaletteSource = {
  group: "threads",
  items: (_query, ctx) =>
    ctx.projects.flatMap((project) =>
      selectProjectThreads(project.id)({ byId: ctx.threads }).map((thread): PaletteItem => ({
        id: `thread:${thread.id}`,
        group: "threads",
        title: thread.title,
        subtitle: project.name,
        icon: <ProviderIcon provider={thread.provider} />,
        run: () => void ctx.navigate({ to: "/thread/$threadId", params: { threadId: thread.id } }),
      })),
    ),
}

export const projectsSource: PaletteSource = {
  group: "projects",
  items: (_query, ctx) =>
    ctx.projects.map((project) => ({
      id: `project:${project.id}`,
      group: "projects",
      title: m.sidebar_new_thread_in({ project: project.name }),
      subtitle: project.rootPath,
      icon: <RiAddLine aria-hidden className={iconClass} />,
      run: () => void startThread(project.id, ctx.navigate),
    })),
}

/** The registry, with each command's effective chord. */
export const commandsSource: PaletteSource = {
  group: "commands",
  items: (_query, ctx) =>
    commands.map((command) => {
      const chord = ctx.keymap[command.id]
      return {
        id: `command:${command.id}`,
        group: "commands",
        title: command.title(),
        ...(chord ? { chord } : {}),
        run: () => command.run(ctx),
      }
    }),
}

/** Adds `@path` to the thread's draft, the same mention the composer's `@` completion inserts. */
const mentionFile = (threadId: string, path: string) => {
  const { text } = useDrafts.getState().byThreadId[threadId] ?? emptyDraft
  const separator = text === "" || /\s$/.test(text) ? "" : " "
  useDrafts.getState().setText(threadId, `${text}${separator}@${path} `)
  useUi.getState().requestComposerFocus()
}

const fileItem = (threadId: string, path: string): PaletteItem => {
  const slash = path.lastIndexOf("/")
  return {
    id: `file:${path}`,
    group: "files",
    title: path.slice(slash + 1),
    ...(slash > 0 ? { subtitle: path.slice(0, slash) } : {}),
    // The whole path, so a query such as "renderer/comp" can span the directory and the name.
    keywords: [path],
    icon: <RiFileTextLine aria-hidden className={iconClass} />,
    run: () => mentionFile(threadId, path),
  }
}

const FILES_TTL_MS = 5_000
let filesCache: { threadId: string; at: number; items: Promise<ReadonlyArray<PaletteItem>> } | null = null

/** Listing a large repo takes a moment, so keystrokes within a few seconds share one listing. */
const threadFiles = (threadId: string) => {
  if (filesCache?.threadId === threadId && Date.now() - filesCache.at < FILES_TTL_MS) return filesCache.items
  const items = callPromise("files.list", { threadId }).then(
    (paths) => paths.map((path) => fileItem(threadId, path)),
    (cause: unknown) => {
      console.error(`Could not list files: ${errorMessage(cause)}`)
      return []
    },
  )
  filesCache = { threadId, at: Date.now(), items }
  return items
}

/** Files in the open thread's workspace. Only for a typed query, since a list of arbitrary files is noise. */
export const filesSource: PaletteSource = {
  group: "files",
  items: (query, ctx) => (ctx.threadId && query.trim() !== "" ? threadFiles(ctx.threadId) : []),
}
