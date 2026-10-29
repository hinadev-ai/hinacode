import { existsSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, dialog, Menu, net, powerMonitor, protocol, safeStorage, session, shell } from "electron"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { makeAppLayer } from "./app.ts"
import { handleContextMenu } from "./contextMenu.ts"
import { chromiumDir, moveLegacyProfile } from "./dataDir.ts"
import { bringToFront, registerIpc, sendToWindows } from "./ipc.ts"
import {
  attachmentRequest,
  BROWSER_PARTITION,
  externalUrl,
  githubAssetId,
  isAllowedNavigation,
  isInside,
  lockDownWebview,
  projectFileRequest,
} from "./security.ts"
import {
  ATTACHMENT_PROTOCOL,
  GITHUB_ASSET_PROTOCOL,
  LIQUID_GLASS_ARGUMENT,
  PROJECT_FILE_PROTOCOL,
} from "../shared/channels.ts"
import { RpcMethods } from "../shared/contract.ts"
import * as ClientSettings from "./services/ClientSettings.ts"
import * as Environments from "./services/Environments.ts"
import * as Files from "./services/Files.ts"
import * as GitHub from "./services/GitHub.ts"
import { Keyring } from "./services/Secrets.ts"
import { startResourceMonitor } from "./resourceMonitor.ts"
import { hydratePath } from "./shellPath.ts"
import { liquidGlass } from "./liquidGlass.ts"
import * as Updater from "./updater.ts"
import devIcon from "../../assets/icon-dev.png?asset"
import releaseIcon from "../../assets/icon.png?asset"

// FIXME: Electron names the Keychain item `kkcode Safe Storage` after the app
app.setName("kkcode")
// FIXME: Windows shows notifications only for the AUMID the installer sets on the Start Menu shortcut
if (process.platform === "win32") app.setAppUserModelId("app.hinacode")
const dataDirOverride = process.env["HINACODE_USER_DATA"]
// FIXME: only the signed release app opens the login Keychain item without a password prompt
if (!app.isPackaged) app.commandLine.appendSwitch("use-mock-keychain")
const dataDir = dataDirOverride || join(homedir(), app.isPackaged ? ".hinacode" : ".hinacode-dev")
if (!dataDirOverride) {
  try {
    moveLegacyProfile(join(app.getPath("appData"), app.isPackaged ? "kkcode" : "kkcode-dev"), dataDir)
  } catch (error) {
    dialog.showErrorBox("HinaCode cannot start", error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
app.setPath("userData", chromiumDir(dataDir))
if (!app.requestSingleInstanceLock()) {
  console.error(`HinaCode is already running on ${dataDir}. Set HINACODE_USER_DATA to run another.`)
  app.exit(0)
}
if (!app.isPackaged) startResourceMonitor(dataDir)
const icon = app.isPackaged ? releaseIcon : devIcon
const pathHydrated = hydratePath(process.env)
protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_PROTOCOL, privileges: { standard: true, secure: true } },
  // FIXME: Electron needs `stream` for <video> and <audio> to seek with Range requests
  { scheme: GITHUB_ASSET_PROTOCOL, privileges: { standard: true, secure: true, stream: true } },
  { scheme: PROJECT_FILE_PROTOCOL, privileges: { standard: true, secure: true, stream: true } },
])

type AppRuntime = ManagedRuntime.ManagedRuntime<
  GitHub.GitHub | Files.Files | Environments.Environments | ClientSettings.ClientSettings,
  unknown
>

const decodeCloudFile = Schema.decodeUnknownOption(RpcMethods["fs.preview"].response)

const fetchFromCloud = async (runtime: AppRuntime, environment: string, call: Environments.ForwardedCall) => {
  const envelope = await runtime.runPromise(
    Effect.flatMap(Environments.Environments, (environments) => environments.forward(environment, call)),
  )
  const file = "error" in envelope ? undefined : Option.getOrUndefined(decodeCloudFile(envelope.result))
  return file === undefined ? new Response(null, { status: 404 }) : fetch(file.dataUrl)
}

const sandboxed = (response: Response) => {
  const headers = new Headers(response.headers)
  headers.set("content-security-policy", "sandbox allow-scripts")
  return new Response(response.body, { status: response.status, headers })
}

const serveAttachments = (runtime: AppRuntime, attachmentsRoot: string) =>
  protocol.handle(ATTACHMENT_PROTOCOL, async (request) => {
    const target = attachmentRequest(request.url)
    if (target === null) return new Response(null, { status: 404 })
    const { path, environment } = target
    if (environment !== null)
      return fetchFromCloud(runtime, environment, { method: "attachments.read", payload: { path } })
    if (!isInside(attachmentsRoot, path)) return new Response(null, { status: 403 })
    return net.fetch(pathToFileURL(path).toString())
  })

const rangeOf = (request: Request): RequestInit => {
  const range = request.headers.get("range")
  return range === null ? {} : { headers: { range } }
}

const serveGitHubAssets = (runtime: AppRuntime) =>
  protocol.handle(GITHUB_ASSET_PROTOCOL, async (request) => {
    const id = githubAssetId(request.url)
    if (id === null) return new Response(null, { status: 404 })
    const token = await runtime.runPromise(Effect.flatMap(GitHub.GitHub, (github) => github.token)).catch(() => null)
    if (token === null) return new Response(null, { status: 401 })
    // FIXME: Electron's net.fetch throws on a manual redirect instead of returning it
    const redirect = await fetch(`https://github.com/user-attachments/assets/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    })
    const signed = externalUrl(redirect.headers.get("location") ?? "")
    if (signed === null) return new Response(null, { status: redirect.status === 404 ? 404 : 502 })
    return net.fetch(signed, rangeOf(request))
  })

const serveProjectFiles = (runtime: AppRuntime) =>
  protocol.handle(PROJECT_FILE_PROTOCOL, async (request) => {
    const target = projectFileRequest(request.url)
    if (target === null) return new Response(null, { status: 404 })
    const cloud = await runtime.runPromise(
      Effect.map(Environments.Environments, (environments) => environments.owner("root", target.root)),
    )
    if (cloud !== undefined)
      return sandboxed(await fetchFromCloud(runtime, cloud, { method: "fs.preview", payload: target }))
    const file = await runtime
      .runPromise(Effect.flatMap(Files.Files, (files) => files.resolve(target.root, target.path)))
      .catch(() => null)
    if (file === null) return new Response(null, { status: 403 })
    return sandboxed(await net.fetch(pathToFileURL(file).toString(), rangeOf(request)))
  })

const safeStorageKeyring = Layer.succeed(
  Keyring,
  Keyring.of({
    seal: (value) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : undefined),
    open: (sealed) => safeStorage.decryptString(sealed),
  }),
)

const QUIT_TIMEOUT_MS = 5000

const devRendererUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"]
const appUrl = devRendererUrl ?? pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href

const httpOnly = (event: Electron.Event<{ url: string }>) => {
  if (!externalUrl(event.url)) event.preventDefault()
}

const keepOnTheWeb = (page: Electron.WebContents) => {
  page.setWindowOpenHandler(({ url }) => {
    const web = externalUrl(url)
    if (web) void page.loadURL(web)
    return { action: "deny" }
  })
  page.on("will-navigate", httpOnly)
  page.on("will-redirect", httpOnly)
}

const limitBrowserPermissions = () => {
  const browser = session.fromPartition(BROWSER_PARTITION)
  browser.setPermissionRequestHandler((_page, permission, respond) =>
    respond(permission === "clipboard-sanitized-write"),
  )
  browser.setPermissionCheckHandler((_page, permission) => permission === "clipboard-sanitized-write")
}

const createWindow = (runtime: AppRuntime) => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    ...(liquidGlass ? { transparent: true, backgroundColor: "#00000000" } : { backgroundColor: "#0a0a0a" }),
    title: "HinaCode",
    icon,
    ...(process.platform === "darwin" && { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 13 } }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      webviewTag: true,
      additionalArguments: liquidGlass ? [LIQUID_GLASS_ARGUMENT] : [],
    },
  })
  liquidGlass?.addView(window.getNativeWindowHandle())
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external) void shell.openExternal(external)
    return { action: "deny" }
  })
  const stayInApp = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!isAllowedNavigation(event.url, event.isMainFrame, appUrl)) event.preventDefault()
  }
  window.webContents.on("will-frame-navigate", stayInApp)
  window.webContents.on("will-redirect", stayInApp)
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!lockDownWebview(preferences as Record<string, unknown>, params)) event.preventDefault()
  })
  window.webContents.on("did-attach-webview", (_event, page) => keepOnTheWeb(page))
  handleContextMenu(window, runtime, appUrl)

  void window.loadURL(appUrl)
}

// FIXME: Electron's default menu labels app items with `app.name`, which stays kkcode
const setMacMenu = () =>
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "HinaCode",
        submenu: [
          { role: "about", label: "About HinaCode" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: "Hide HinaCode" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: "Quit HinaCode" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  )

app.whenReady().then(async () => {
  await pathHydrated
  const sbxConfigPath = join(app.getPath("appData"), "sbx", "config.json")
  const dbPath = join(dataDir, "hinacode.sqlite")
  if (!existsSync(dbPath)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const previous = join(dataDir, `kkcode.sqlite${suffix}`)
      if (existsSync(previous)) renameSync(previous, `${dbPath}${suffix}`)
    }
  }
  const runtime = ManagedRuntime.make(
    makeAppLayer({
      userData: dataDir,
      sbxConfigPath,
      keyring: safeStorageKeyring,
      updates: Updater.layer,
      toWindows: sendToWindows,
    }),
  )
  await runtime.runPromise(Effect.void)
  let disposed = false
  app.on("before-quit", (event) => {
    if (disposed) return
    event.preventDefault()
    disposed = true
    const disposal = runtime.dispose().catch((cause: unknown) => console.error("runtime dispose failed", cause))
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
    void Promise.race([disposal, timeout]).then(() => app.quit())
  })
  registerIpc(runtime, appUrl)
  powerMonitor.on("resume", () =>
    runtime.runFork(Effect.flatMap(Environments.Environments, (environments) => environments.reconnectAll)),
  )
  app.dock?.setIcon(icon)
  if (process.platform === "darwin") setMacMenu()
  serveAttachments(runtime, join(dataDir, "attachments"))
  serveGitHubAssets(runtime)
  serveProjectFiles(runtime)
  limitBrowserPermissions()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(runtime)
  })
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) bringToFront(window)
    else createWindow(runtime)
  })
  createWindow(runtime)
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
