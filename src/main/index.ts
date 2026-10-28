import { existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, Menu, net, powerMonitor, protocol, safeStorage, session, shell } from "electron"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { makeAppLayer } from "./app.ts"
import { handleContextMenu } from "./contextMenu.ts"
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

// Without this, launching `electron out/main/index.js` names the app "Electron" and userData moves. The name
// stays "kkcode", the product's name before HinaCode, so installs keep their profile directory and the
// Keychain item their secrets are sealed with.
app.setName("kkcode")
// Windows shows notifications only for the AUMID on the Start Menu shortcut, which the installer sets to the appId.
if (process.platform === "win32") app.setAppUserModelId("app.hinacode")
// Lets several instances run side by side during development and testing.
const userDataOverride = process.env["HINACODE_USER_DATA"]
if (userDataOverride) app.setPath("userData", userDataOverride)
// Only the signed release app is on the access list of the login Keychain item `kkcode Safe Storage`. Any other
// binary (each worktree's dev build, e2e) would ask for the login password on every boot,
// so it seals secrets with Chromium's public test key. That key cannot open the release app's secrets, so an
// unpackaged run also defaults to a profile of its own.
if (!app.isPackaged) app.commandLine.appendSwitch("use-mock-keychain")
if (!app.isPackaged && !userDataOverride) app.setPath("userData", join(app.getPath("appData"), "kkcode-dev"))
// Electron keys the lock on userData. A second process on the same database would run its own pollers and
// agents, and the threads it starts never reach the first process's window.
if (!app.requestSingleInstanceLock()) {
  console.error(`HinaCode is already running on ${app.getPath("userData")}. Set HINACODE_USER_DATA to run another.`)
  app.exit(0)
}
if (!app.isPackaged) startResourceMonitor(app.getPath("userData"))
const icon = app.isPackaged ? releaseIcon : devIcon
// The login shell takes most of a second to start, so it runs while Electron gets ready.
const pathHydrated = hydratePath(process.env)
protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_PROTOCOL, privileges: { standard: true, secure: true } },
  // `stream` lets <video> and <audio> seek with Range requests.
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

/** Serves `hinacode-attachment://file/<encoded absolute path>`, only for files inside the attachments dir. */
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

/**
 * Serves `hinacode-github-asset://asset/<id>` from `github.com/user-attachments/assets/<id>`, which private
 * repositories only answer for a signed-in account. GitHub redirects to a short-lived signed URL, fetched
 * without the token.
 */
const serveGitHubAssets = (runtime: AppRuntime) =>
  protocol.handle(GITHUB_ASSET_PROTOCOL, async (request) => {
    const id = githubAssetId(request.url)
    if (id === null) return new Response(null, { status: 404 })
    const token = await runtime.runPromise(Effect.flatMap(GitHub.GitHub, (github) => github.token)).catch(() => null)
    if (token === null) return new Response(null, { status: 401 })
    // Node's fetch, because Electron's net.fetch throws on a manual redirect instead of returning it.
    const redirect = await fetch(`https://github.com/user-attachments/assets/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    })
    const signed = externalUrl(redirect.headers.get("location") ?? "")
    if (signed === null) return new Response(null, { status: redirect.status === 404 ? 404 : 502 })
    return net.fetch(signed, rangeOf(request))
  })

/**
 * Serves `hinacode-file://root/<encoded root>/<path>` for files inside a project root or worktree. The CSP
 * sandbox runs every served document in an opaque origin without popups or top navigation, however it is
 * embedded, so an HTML file can run its scripts but never reach the app.
 */
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

// A packaged app started from an agent's terminal inside `pnpm dev` inherits this variable.
const devRendererUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"]
const appUrl = devRendererUrl ?? pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href

const httpOnly = (event: Electron.Event<{ url: string }>) => {
  if (!externalUrl(event.url)) event.preventDefault()
}

/** A page in the in-app browser stays on http(s) and opens new windows in place. */
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
  // Copy buttons in dev pages write sanitized text to the clipboard; every other permission is refused.
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
    // The glass draws behind the web contents, so the window itself must be clear.
    ...(liquidGlass ? { transparent: true, backgroundColor: "#00000000" } : { backgroundColor: "#0a0a0a" }),
    title: "HinaCode",
    icon,
    // The renderer draws its own title bar around the traffic lights (see TitleBar.tsx).
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

// The default menu labels its app items with `app.name`, which stays "hinacode" to keep userData and the Keychain item.
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
  const userData = app.getPath("userData")
  // Where `sbx login` keeps its login on macOS and Linux.
  const sbxConfigPath = join(app.getPath("appData"), "sbx", "config.json")
  const dbPath = join(userData, "hinacode.sqlite")
  // The database was kkcode.sqlite until the rename to HinaCode, so an existing profile keeps its threads.
  if (!existsSync(dbPath)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const previous = join(userData, `kkcode.sqlite${suffix}`)
      if (existsSync(previous)) renameSync(previous, `${dbPath}${suffix}`)
    }
  }
  const runtime = ManagedRuntime.make(
    makeAppLayer({
      userData,
      sbxConfigPath,
      keyring: safeStorageKeyring,
      updates: Updater.layer,
      toWindows: sendToWindows,
    }),
  )
  // Build the layer (open the database, run migrations) before anything can call in.
  await runtime.runPromise(Effect.void)
  let disposed = false
  app.on("before-quit", (event) => {
    if (disposed) return
    // Holds the quit until running turns persist their messages and status, but not forever.
    event.preventDefault()
    disposed = true
    const disposal = runtime.dispose().catch((cause: unknown) => console.error("runtime dispose failed", cause))
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
    void Promise.race([disposal, timeout]).then(() => app.quit())
  })
  registerIpc(runtime, appUrl)
  // Clouds dropped while asleep would otherwise wait out a backoff of up to a minute after waking.
  powerMonitor.on("resume", () =>
    runtime.runFork(Effect.flatMap(Environments.Environments, (environments) => environments.reconnectAll)),
  )
  app.dock?.setIcon(icon)
  if (process.platform === "darwin") setMacMenu()
  serveAttachments(runtime, join(userData, "attachments"))
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
