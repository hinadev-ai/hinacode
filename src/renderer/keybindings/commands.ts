import type { useNavigate } from "@tanstack/react-router"
import type { RpcRequest } from "../../shared/contract.ts"
import type { Project, Settings } from "../../shared/domain.ts"
import { startThread } from "../lib/startThread.ts"
import { m } from "../paraglide/messages.js"
import { useLocale } from "../stores/locale.ts"
import { selectProjectThreads, useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"

export interface CommandContext {
  readonly navigate: ReturnType<typeof useNavigate>
  /** The open thread, or null outside a thread route. */
  readonly threadId: string | null
  readonly projects: ReadonlyArray<Project>
  readonly updateSettings: (patch: RpcRequest<"settings.set">) => Promise<Settings>
}

export interface Command {
  readonly id: string
  /** Canonical chord, or "" for unbound by default. */
  readonly defaultKeys: string
  readonly title: () => string
  readonly run: (ctx: CommandContext) => void
}

const threadsInSidebarOrder = (projects: ReadonlyArray<Project>) => {
  const state = useThreads.getState()
  return projects.flatMap((project) => selectProjectThreads(project.id)(state))
}

const goToSiblingThread = (ctx: CommandContext, step: 1 | -1) => {
  const threads = threadsInSidebarOrder(ctx.projects)
  if (threads.length === 0) return
  const index = threads.findIndex((thread) => thread.id === ctx.threadId)
  // From outside a thread, "next" starts at the top and "previous" at the bottom.
  const target = index === -1 ? threads.at(step === 1 ? 0 : -1) : threads.at((index + step) % threads.length)
  if (target) void ctx.navigate({ to: "/thread/$threadId", params: { threadId: target.id } })
}

export const commands = [
  {
    id: "settings.open",
    defaultKeys: "mod+,",
    title: m.command_settings_open,
    run: (ctx) => void ctx.navigate({ to: "/settings" }),
  },
  {
    id: "thread.new",
    defaultKeys: "mod+n",
    title: m.command_thread_new,
    run: (ctx) => {
      const current = ctx.threadId ? useThreads.getState().byId[ctx.threadId] : undefined
      const projectId = current?.projectId ?? ctx.projects[0]?.id
      if (projectId) void startThread(projectId, ctx.navigate)
      else useUi.getState().setAddProjectOpen(true)
    },
  },
  {
    id: "project.add",
    defaultKeys: "mod+shift+n",
    title: m.command_project_add,
    run: () => useUi.getState().setAddProjectOpen(true),
  },
  {
    id: "sidebar.toggle",
    defaultKeys: "mod+b",
    title: m.command_sidebar_toggle,
    run: () => useUi.getState().toggleSidebar(),
  },
  {
    id: "sidePanel.toggle",
    defaultKeys: "mod+.",
    title: m.command_side_panel_toggle,
    run: () => useUi.getState().toggleSidePanel(),
  },
  {
    id: "composer.focus",
    defaultKeys: "mod+l",
    title: m.command_composer_focus,
    run: () => useUi.getState().requestComposerFocus(),
  },
  {
    id: "explorer.focus",
    defaultKeys: "mod+shift+e",
    title: m.command_explorer_focus,
    run: (ctx) => {
      if (ctx.threadId) useUi.getState().requestExplorerFocus()
    },
  },
  {
    id: "turn.interrupt",
    defaultKeys: "mod+shift+c",
    title: m.command_turn_interrupt,
    run: () => useUi.getState().requestInterrupt(),
  },
  {
    id: "thread.next",
    defaultKeys: "mod+shift+]",
    title: m.command_thread_next,
    run: (ctx) => goToSiblingThread(ctx, 1),
  },
  {
    id: "thread.previous",
    defaultKeys: "mod+shift+[",
    title: m.command_thread_previous,
    run: (ctx) => goToSiblingThread(ctx, -1),
  },
  {
    id: "language.switch",
    defaultKeys: "",
    title: m.command_language_switch,
    run: (ctx) => {
      const next = useLocale.getState().locale === "en" ? "zh-TW" : "en"
      void ctx.updateSettings({ locale: next }).then((saved) => useLocale.getState().apply(saved.locale))
    },
  },
] as const satisfies ReadonlyArray<Command>

export type CommandId = (typeof commands)[number]["id"]

/** Command id -> effective chord ("" when unbound): defaults overlaid by the user's overrides. */
export const resolveKeymap = (overrides: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.fromEntries(commands.map((command) => [command.id, overrides[command.id] ?? command.defaultKeys]))

/** Ids of the other commands bound to the same chord as `id`. */
export const conflictsOf = (keymap: Readonly<Record<string, string>>, id: string): Array<Command> => {
  const chord = keymap[id]
  if (!chord) return []
  return commands.filter((command) => command.id !== id && keymap[command.id] === chord)
}
