import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { Effect, type ManagedRuntime, Option, Schema } from "effect"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import { type PushEvent, type RpcEnvelope, type RpcMethod, RpcMethods } from "../shared/contract.ts"
import { routes } from "../shared/routes.ts"
import { askNotificationPermission, notificationPermission } from "./notificationPermission.ts"
import { type AppServices, type DesktopCalls, dispatch, type HandlerError, RpcCall } from "./rpc.ts"
import { listOpeners, openWith } from "./openers.ts"
import { externalUrl, isTrustedSender } from "./security.ts"
import { inlineSource } from "./services/Attachments.ts"
import { Environments } from "./services/Environments.ts"

/** Only for when the user asked for the window, such as a notification click or opening hinacode again. */
export const bringToFront = (window: BrowserWindow) => {
  if (window.isMinimized()) window.restore()
  window.show()
  // macOS won't activate an app behind another one on window.focus() alone.
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

/** The renderer's envelope: `environment` names a cloud for the methods whose route is `named`. */
const WindowCall = Schema.Struct({ ...RpcCall.fields, environment: Schema.optional(Schema.String) })
const decodeWindowCall = Schema.decodeUnknownOption(WindowCall)

const payloadId = (payload: unknown, key: string) => {
  const id = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined
  return typeof id === "string" ? id : undefined
}

const inlineLocalAttachment = (method: RpcMethod, payload: unknown): Effect.Effect<unknown, HandlerError> =>
  method !== "attachments.stage"
    ? Effect.succeed(payload)
    : Schema.decodeUnknownEffect(RpcMethods[method].request)(payload).pipe(
        Effect.flatMap((request) =>
          "path" in request.source
            ? Effect.map(inlineSource(request.source.path), (source) => ({ ...request, source }))
            : Effect.succeed(request),
        ),
      )

/** Finds where a window call runs (see `environments/routes.ts`): this desktop, one cloud, or all of them. */
const route = (raw: unknown, desktop: DesktopCalls) =>
  Effect.gen(function* () {
    const decoded = Option.getOrUndefined(decodeWindowCall(raw))
    if (decoded === undefined) return yield* dispatch(raw, desktop)
    const environments = yield* Environments
    const { method, payload, environment } = decoded
    const where = routes[method]
    const owned = where.to === "owner" ? payloadId(payload, where.key) : undefined
    const target =
      where.to === "named"
        ? environment
        : where.to === "owner" && owned !== undefined
          ? environments.owner(where.entity, owned)
          : undefined
    if (target !== undefined) {
      return yield* inlineLocalAttachment(method, payload).pipe(
        Effect.flatMap((forwarded) => environments.forward(target, { method, payload: forwarded })),
        Effect.catch((error) => Effect.succeed({ error: { tag: error._tag, message: error.message } })),
      )
    }
    if (where.to !== "all") return yield* dispatch(raw, desktop)
    const [local, clouds] = yield* Effect.all([dispatch(raw, desktop), environments.gather({ method, payload })], {
      concurrency: "unbounded",
    })
    if ("error" in local || !Array.isArray(local.result)) return local
    return { result: [...local.result, ...clouds] }
  })

/** `appUrl` is the renderer document; RPC from any other document or from a subframe is refused. */
export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown>, appUrl: string) => {
  ipcMain.handle(RPC_CHANNEL, (event, raw: unknown) =>
    isTrustedSender(event.senderFrame, appUrl)
      ? runtime.runPromise(route(raw, desktopCalls(BrowserWindow.fromWebContents(event.sender))))
      : Promise.resolve(untrustedSender),
  )
}

/** The desktop's window sink for `makeEventsLayer`. */
export const sendToWindows = (encoded: typeof PushEvent.Encoded) => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EVENT_CHANNEL, encoded)
}
