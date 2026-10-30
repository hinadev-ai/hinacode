import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron"
import { Effect, type ManagedRuntime } from "effect"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import type { PushEvent, RpcEnvelope } from "../shared/contract.ts"
import { route } from "./environments/route.ts"
import { askNotificationPermission, notificationPermission } from "./notificationPermission.ts"
import type { AppServices, DesktopCalls } from "./rpc.ts"
import { listOpeners, openWith } from "./openers.ts"
import { externalUrl, isTrustedSender } from "./security.ts"

export const bringToFront = (window: BrowserWindow) => {
  if (window.isMinimized()) window.restore()
  window.show()
  // FIXME: macOS won't activate an app behind another one on window.focus() alone
  app.focus({ steal: true })
  window.focus()
}

const showOpenDialog = (window: BrowserWindow | null, options: Electron.OpenDialogOptions) =>
  Effect.promise(() => (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)))

const desktopCalls = (window: BrowserWindow | null): DesktopCalls => ({
  show: Effect.sync(() => window?.show()),
  focus: Effect.sync(() => {
    if (window) bringToFront(window)
  }),
  setBadgeCount: (count) => Effect.sync(() => app.setBadgeCount(count)),
  setColorScheme: (scheme) =>
    Effect.sync(() => {
      nativeTheme.themeSource = scheme
    }),
  reveal: (path) => Effect.sync(() => shell.showItemInFolder(path)),
  openExternal: (url) => {
    const allowed = externalUrl(url)
    return allowed === null
      ? Effect.void
      : Effect.tryPromise(() => shell.openExternal(allowed)).pipe(
          Effect.catch((error) => Effect.logWarning("could not open the browser", error)),
        )
  },
  openers: listOpeners,
  openWith,
  pickFolder: Effect.map(showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] }), (result) =>
    result.canceled ? null : (result.filePaths[0] ?? null),
  ),
  pickFiles: Effect.map(showOpenDialog(window, { properties: ["openFile", "multiSelections"] }), (result) =>
    result.canceled ? [] : result.filePaths,
  ),
  notificationPermission,
  askNotificationPermission,
  screenOwner: window?.webContents ?? null,
})

const untrustedSender: RpcEnvelope<never> = {
  error: { tag: "UntrustedSender", message: "RPC is only available to the HinaCode window" },
}

export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown>, appUrl: string) => {
  ipcMain.handle(RPC_CHANNEL, (event, raw: unknown) =>
    isTrustedSender(event.senderFrame, appUrl)
      ? runtime.runPromise(route(raw, desktopCalls(BrowserWindow.fromWebContents(event.sender))))
      : Promise.resolve(untrustedSender),
  )
}

export const sendToWindows = (encoded: typeof PushEvent.Encoded) => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EVENT_CHANNEL, encoded)
}
