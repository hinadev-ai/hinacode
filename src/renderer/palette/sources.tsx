import { RiAddLine, RiFileTextLine } from "react-icons/ri"
import { ProjectIcon } from "../components/ProjectIcon.tsx"
import { ProviderIcon } from "../components/ProviderIcon.tsx"
import { commands, isCommandAvailable } from "../keybindings/commands.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { startThread } from "../lib/startThread.ts"
import { m } from "../paraglide/messages.js"
import { useExplorer } from "../stores/explorer.ts"
import { selectProjectThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { type Project, threadFolder, Thread } from "../../shared/domain.ts"
import type { PaletteContext, PaletteItem, PaletteSource } from "./types.ts"

const iconClass = "size-3.5 shrink-0 text-muted-foreground"

const cloudOf = (project: Project, ctx: PaletteContext): Pick<PaletteItem, "cloud" | "keywords"> => {
  const cloud = ctx.clouds.find((candidate) => candidate.id === project.environmentId)
  return cloud ? { cloud, keywords: [cloud.name] } : {}
}

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
        ...cloudOf(project, ctx),
        run: () => void ctx.navigate({ to: "/thread/$threadId", params: { threadId: thread.id } }),
      })),
    ),
}

export const projectsSource: PaletteSource = {
  group: "projects",
  items: (_query, ctx) =>
    ctx.projects.map((project): PaletteItem => ({
      id: `project:${project.id}`,
      group: "projects",
      title: m.sidebar_new_thread_in({ project: project.name }),
      subtitle: project.rootPath,
      icon: <RiAddLine aria-hidden className={iconClass} />,
      ...cloudOf(project, ctx),
      run: () => void startThread(project.id, ctx.navigate),
    })),
}

export const newThreadSource: PaletteSource = {
  group: "projects",
  items: (_query, ctx) => {
    const items = ctx.projects.map((project, index): PaletteItem => ({
      id: `new-thread:${project.id}`,
      group: "projects",
      title: project.name,
      subtitle: project.rootPath,
      icon: <ProjectIcon projectId={project.id} />,
      ...cloudOf(project, ctx),
      ...(index < 9 ? { chord: `Mod+${index + 1}` } : {}),
      run: () => void startThread(project.id, ctx.navigate),
    }))
    const newest = Object.values(ctx.threads)
      .filter((thread) => thread.createdBy === "user")
      .reduce<Thread | undefined>(
        (latest, thread) => (latest && latest.createdAt > thread.createdAt ? latest : thread),
        undefined,
      )
    const preferred = ctx.threadId ? ctx.threads[ctx.threadId]?.projectId : newest?.projectId
    const current = `new-thread:${preferred}`
    const isCurrent = (item: PaletteItem) => item.id === current
    return [...items.filter(isCurrent), ...items.filter((item) => !isCurrent(item))]
  },
}

export const commandsSource: PaletteSource = {
  group: "commands",
  items: (_query, ctx) =>
    commands
      .filter((command) => isCommandAvailable(command, ctx.experimental))
      .map((command) => {
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

export const openFile = (ctx: PaletteContext, path: string) => {
  const thread = ctx.threadId ? ctx.threads[ctx.threadId] : undefined
  if (!thread) return
  const worktree = thread.worktreeId ? useWorktrees.getState().byId[thread.worktreeId] : undefined
  const live = worktree?.status === "removed" ? undefined : worktree
  const project = ctx.projects.find((candidate) => candidate.id === thread.projectId)
  const root = live?.path ?? (project && threadFolder(project, thread.id))
  if (root === undefined) return
  useExplorer.getState().open(root, path)
  useUi.getState().showView(thread.id, "files")
}

const fileItem = (ctx: PaletteContext, path: string): PaletteItem => {
  const slash = path.lastIndexOf("/")
  return {
    id: `file:${path}`,
    group: "files",
    title: path.slice(slash + 1),
    ...(slash > 0 ? { subtitle: path.slice(0, slash) } : {}),
    keywords: [path],
    icon: <RiFileTextLine aria-hidden className={iconClass} />,
    run: () => openFile(ctx, path),
  }
}

const FILES_TTL_MS = 5_000
let filesCache: { threadId: string; at: number; items: Promise<ReadonlyArray<PaletteItem>> } | null = null

const threadFiles = (threadId: string, ctx: PaletteContext) => {
  if (filesCache?.threadId === threadId && Date.now() - filesCache.at < FILES_TTL_MS) return filesCache.items
  const items = callPromise("files.list", { threadId }).then(
    (paths) => paths.map((path) => fileItem(ctx, path)),
    (cause: unknown) => {
      console.error(`Could not list files: ${errorMessage(cause)}`)
      return []
    },
  )
  filesCache = { threadId, at: Date.now(), items }
  return items
}

export const filesSource: PaletteSource = {
  group: "files",
  items: (query, ctx) => (ctx.threadId && query.trim() !== "" ? threadFiles(ctx.threadId, ctx) : []),
}
