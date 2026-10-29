import { type BaseWindow, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron"
import { Effect, Stream } from "effect"
import { EVENT_CHANNEL } from "../shared/channels.ts"
import type { MenuCommand, PushEvent } from "../shared/contract.ts"
import type { Locale } from "../shared/domain.ts"
import * as m from "../renderer/paraglide/messages.js"
import { ClientSettings } from "./services/ClientSettings.ts"

const run = (command: MenuCommand) => (_item: unknown, window: BaseWindow | undefined) => {
  const event: typeof PushEvent.Encoded = { type: "menu.command", command }
  if (window instanceof BrowserWindow) window.webContents.send(EVENT_CHANNEL, event)
}

const appMenu = (locale: Locale) => {
  const mac = process.platform === "darwin"
  const settings: MenuItemConstructorOptions = {
    label: m.menu_settings({}, { locale }),
    click: run("settings.open"),
  }
  return Menu.buildFromTemplate([
    ...(mac
      ? [
          {
            // The default labels use `app.name`, which stays "kkcode" to keep the Keychain item.
            label: "HinaCode",
            submenu: [
              { role: "about", label: "About HinaCode" },
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide", label: "Hide HinaCode" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit", label: "Quit HinaCode" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: m.menu_file({}, { locale }),
      submenu: [
        { label: m.command_thread_new({}, { locale }), click: run("thread.new") },
        { label: m.menu_add_project({}, { locale }), click: run("project.add") },
        { type: "separator" },
        ...(mac ? [] : [settings, { type: "separator" } satisfies MenuItemConstructorOptions]),
        { role: "close" },
        ...(mac ? [] : [{ role: "quit", label: "Quit HinaCode" } satisfies MenuItemConstructorOptions]),
      ],
    },
    { role: "editMenu" },
    {
      label: m.menu_view({}, { locale }),
      submenu: [
        { label: m.command_sidebar_toggle({}, { locale }), click: run("sidebar.toggle") },
        { label: m.command_side_panel_toggle({}, { locale }), click: run("sidePanel.toggle") },
        { label: m.command_terminal_toggle({}, { locale }), click: run("terminal.toggle") },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ])
}

/** Sets the application menu in the app's language, and sets it again whenever the language changes. */
export const keepAppMenu = Effect.gen(function* () {
  const settings = yield* ClientSettings
  const changes = yield* settings.changes
  const { locale } = yield* settings.get
  Menu.setApplicationMenu(appMenu(locale))
  yield* changes.pipe(
    Stream.map((next) => next.locale),
    Stream.changes,
    Stream.runForEach((next) => Effect.sync(() => Menu.setApplicationMenu(appMenu(next)))),
  )
}).pipe(Effect.scoped)
