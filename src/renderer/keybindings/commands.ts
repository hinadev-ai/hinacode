import { detectPlatform, formatForDisplay, type Hotkey, normalizeHotkey, validateHotkey } from "@tanstack/react-hotkeys"
import type { RouterHistory, useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import { AtomRegistry } from "effect/reactivity"
import type { RpcRequest } from "../../shared/contract.ts"
import { type ClientSettings, type ExperimentalSettings, Locale, type Project } from "../../shared/domain.ts"
import { registry } from "../lib/registry.ts"
import { projectsAtom } from "../lib/rpc.ts"
import {
  COMMAND_PREFIX,
  IMPORT_SESSION_PREFIX,
  NEW_THREAD_PREFIX,
  SEARCH_PREFIX,
  usePalette,
} from "../palette/usePalette.ts"
import { m } from "../paraglide/messages.js"
import { useBrowserTabs } from "../stores/browserTabs.ts"
import { useLocale } from "../stores/locale.ts"
import { useTerminals } from "../stores/terminals.ts"
import { selectProjectThreads, useThreads } from "../stores/threads.ts"
import { type SidePanelViewId, useUi } from "../stores/ui.ts"

export interface CommandContext {
  readonly navigate: ReturnType<typeof useNavigate>
  readonly history: RouterHistory
  readonly threadId: string | null
  readonly projects: ReadonlyArray<Project>
  readonly updateClientSettings: (patch: RpcRequest<"clientSettings.set">) => Promise<ClientSettings>
  readonly experimental: ExperimentalSettings
}

export type KeyContext = Readonly<{ terminalFocus: boolean }>

export type When = keyof KeyContext | `!${keyof KeyContext}`

export const whenHolds = (when: When | undefined, context: KeyContext) => {
  if (when === undefined) return true
  const negated = when.startsWith("!")
  return context[(negated ? when.slice(1) : when) as keyof KeyContext] !== negated
}

export interface Command {
  readonly id: string
  readonly defaultKeys: string
  readonly title: () => string
  readonly run: (ctx: CommandContext) => void
  readonly when?: When
  readonly experiment?: keyof ExperimentalSettings
}

export const isCommandAvailable = (command: Command, experimental: ExperimentalSettings) =>
  command.experiment === undefined || experimental[command.experiment]

const threadsInSidebarOrder = (projects: ReadonlyArray<Project>) => {
  const state = useThreads.getState()
  return projects.flatMap((project) => selectProjectThreads(project.id)(state))
}

const goToSiblingThread = (ctx: CommandContext, step: 1 | -1) => {
  const threads = threadsInSidebarOrder(ctx.projects)
  if (threads.length === 0) return
  const index = threads.findIndex((thread) => thread.id === ctx.threadId)
  const target = index === -1 ? threads.at(step === 1 ? 0 : -1) : threads.at((index + step) % threads.length)
  if (target) void ctx.navigate({ to: "/thread/$threadId", params: { threadId: target.id } })
}

const cycleRecentThreads = (ctx: CommandContext, step: 1 | -1) => {
  const { byId } = useThreads.getState()
  useUi.getState().cycleThreadSwitcher(ctx.threadId, step, (id) => id in byId)
}

const showView = (ctx: CommandContext, view: SidePanelViewId) => {
  if (ctx.threadId) useUi.getState().toggleView(ctx.threadId, view, { focus: true })
}

export const commands = [
  {
    id: "palette.open",
    defaultKeys: "mod+p",
    title: m.command_palette_open,
    run: () => usePalette.getState().show(""),
  },
  {
    id: "palette.commands",
    defaultKeys: "mod+shift+p",
    title: m.command_palette_commands,
    run: () => usePalette.getState().show(COMMAND_PREFIX),
  },
  {
    id: "settings.open",
    defaultKeys: "mod+,",
    title: m.command_settings_open,
    run: (ctx) => void ctx.navigate({ to: "/settings" }),
  },
  {
    id: "resources.show",
    defaultKeys: "",
    title: m.command_resources_show,
    run: () => useUi.getState().setResourcesOpen(true),
  },
  {
    id: "thread.new",
    defaultKeys: "mod+n",
    title: m.command_thread_new,
    run: () =>
      void Effect.runPromise(AtomRegistry.getResult(registry, projectsAtom).pipe(Effect.orElseSucceed(() => []))).then(
        (projects) =>
          projects.length > 0
            ? usePalette.getState().show(NEW_THREAD_PREFIX)
            : useUi.getState().setAddProjectOpen(true),
      ),
    when: "!terminalFocus",
  },
  {
    id: "session.import",
    defaultKeys: "",
    title: m.command_session_import,
    run: () => usePalette.getState().show(IMPORT_SESSION_PREFIX),
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
    when: "!terminalFocus",
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
    when: "!terminalFocus",
  },
  {
    id: "composer.model",
    defaultKeys: detectPlatform() === "mac" ? "mod+ctrl+m" : "mod+alt+m",
    title: m.command_composer_model,
    run: () => useUi.getState().requestPicker("model"),
  },
  {
    id: "composer.effort",
    defaultKeys: "mod+alt+,",
    title: m.command_composer_effort,
    run: () => useUi.getState().requestPicker("effort"),
  },
  // FIXME: Electron's default menu takes mod+shift+r and mod+shift+i before the page sees them
  {
    id: "view.details",
    defaultKeys: "mod+shift+o",
    title: m.command_view_details,
    run: (ctx) => showView(ctx, "details"),
  },
  {
    id: "view.files",
    defaultKeys: "mod+shift+e",
    title: m.command_view_files,
    run: (ctx) => showView(ctx, "files"),
  },
  {
    id: "view.changes",
    defaultKeys: "mod+shift+d",
    title: m.command_view_changes,
    run: (ctx) => showView(ctx, "changes"),
  },
  {
    id: "view.git",
    defaultKeys: "mod+shift+g",
    title: m.command_view_git,
    run: (ctx) => showView(ctx, "git"),
  },
  {
    id: "view.pullRequests",
    defaultKeys: "mod+shift+m",
    title: m.command_view_pull_requests,
    run: (ctx) => showView(ctx, "pullRequests"),
  },
  {
    id: "view.agents",
    defaultKeys: "mod+shift+a",
    title: m.command_view_agents,
    run: (ctx) => showView(ctx, "agents"),
    when: "!terminalFocus",
  },
  {
    id: "view.sidechat",
    defaultKeys: "",
    title: m.command_view_sidechat,
    run: (ctx) => showView(ctx, "sidechat"),
  },
  {
    id: "view.browser",
    defaultKeys: "mod+shift+b",
    title: m.command_view_browser,
    run: (ctx) => showView(ctx, "browser"),
  },
  {
    id: "browser.newTab",
    defaultKeys: "mod+t",
    title: m.command_browser_new_tab,
    run: (ctx) => {
      if (!ctx.threadId) return
      useUi.getState().showView(ctx.threadId, "browser")
      useBrowserTabs.getState().openTab(ctx.threadId)
    },
  },
  {
    id: "view.tinyVm",
    defaultKeys: "",
    title: m.command_view_tiny_vm,
    run: (ctx) => showView(ctx, "tinyVm"),
    experiment: "tinyVm",
  },
  {
    id: "view.devices",
    defaultKeys: "",
    title: m.command_view_devices,
    run: (ctx) => showView(ctx, "devices"),
    experiment: "devices",
  },
  {
    id: "turn.interrupt",
    defaultKeys: "mod+shift+c",
    title: m.command_turn_interrupt,
    run: () => useUi.getState().requestInterrupt(),
    when: "!terminalFocus",
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
    id: "thread.snooze",
    defaultKeys: "mod+shift+s",
    title: m.command_thread_snooze,
    run: (ctx) => {
      if (ctx.threadId) useUi.getState().setSnoozeThreadId(ctx.threadId)
    },
  },
  {
    id: "thread.switchRecent",
    defaultKeys: "Control+Tab",
    title: m.command_thread_switch_recent,
    run: (ctx) => cycleRecentThreads(ctx, 1),
  },
  {
    id: "thread.switchRecentBack",
    defaultKeys: "Control+Shift+Tab",
    title: m.command_thread_switch_recent_back,
    run: (ctx) => cycleRecentThreads(ctx, -1),
  },
  {
    id: "navigation.back",
    defaultKeys: "mod+[",
    title: m.command_navigation_back,
    run: (ctx) => ctx.history.back(),
    when: "!terminalFocus",
  },
  {
    id: "navigation.forward",
    defaultKeys: "mod+]",
    title: m.command_navigation_forward,
    run: (ctx) => ctx.history.forward(),
    when: "!terminalFocus",
  },
  {
    id: "search.find",
    defaultKeys: "mod+f",
    title: m.command_search_find,
    run: (ctx) => {
      if (ctx.threadId) useUi.getState().openFind(ctx.threadId)
    },
    when: "!terminalFocus",
  },
  {
    id: "search.global",
    defaultKeys: "mod+shift+f",
    title: m.command_search_global,
    run: () => usePalette.getState().show(SEARCH_PREFIX),
  },
  {
    id: "terminal.toggle",
    defaultKeys: "mod+j",
    title: m.command_terminal_toggle,
    run: (ctx) => {
      if (!ctx.threadId) return
      const open = useTerminals.getState().byThreadId[ctx.threadId]?.open ?? false
      void useTerminals.getState().toggle(ctx.threadId)
      if (open) useUi.getState().requestComposerFocus()
    },
  },
  {
    id: "terminal.new",
    defaultKeys: "mod+shift+`",
    title: m.command_terminal_new,
    run: (ctx) => {
      if (ctx.threadId) void useTerminals.getState().openSession(ctx.threadId)
    },
  },

  {
    id: "language.switch",
    defaultKeys: "",
    title: m.command_language_switch,
    run: (ctx) => {
      const locales = Locale.literals
      const next = locales[(locales.indexOf(useLocale.getState().locale) + 1) % locales.length]
      void ctx.updateClientSettings({ locale: next }).then((saved) => useLocale.getState().apply(saved.locale))
    },
  },
] as const satisfies ReadonlyArray<Command>

export type CommandId = (typeof commands)[number]["id"]

export type Keymap = Readonly<Record<string, Hotkey | "">>

const toHotkey = (chord: string): Hotkey | "" => (validateHotkey(chord).valid ? normalizeHotkey(chord) : "")

export const resolveKeymap = (overrides: Readonly<Record<string, string>>): Keymap =>
  Object.fromEntries(commands.map((command) => [command.id, toHotkey(overrides[command.id] ?? command.defaultKeys)]))

export const sameChord = (a: string, b: string) => formatForDisplay(a) === formatForDisplay(b)

export const conflictsOf = (keymap: Keymap, id: string): Array<Command> => {
  const chord = keymap[id]
  if (!chord) return []
  return commands.filter((command) => {
    const other = keymap[command.id]
    return command.id !== id && !!other && sameChord(chord, other)
  })
}
