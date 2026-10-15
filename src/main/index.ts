import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { app, BrowserWindow, net, protocol, session, shell } from "electron"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as ClaudeProvider from "./agents/claude/index.ts"
import { usageLimitLayer } from "./agents/claude/mock.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import { MuseProvider } from "./agents/muse/index.ts"
import * as Db from "./db/client.ts"
import { bringToFront, makeEventsLayer, registerIpc } from "./ipc.ts"
import {
  BROWSER_PARTITION,
  externalUrl,
  githubAssetId,
  isAllowedNavigation,
  isInside,
  lockDownWebview,
  projectFileRequest,
} from "./security.ts"
import { ATTACHMENT_PROTOCOL, GITHUB_ASSET_PROTOCOL, PROJECT_FILE_PROTOCOL } from "../shared/channels.ts"
import * as AgentAccounts from "./services/AgentAccounts.ts"
import * as AgentLogins from "./services/AgentLogins.ts"
import * as AgentRunner from "./services/AgentRunner.ts"
import * as Attachments from "./services/Attachments.ts"
import * as AutoArchive from "./services/AutoArchive.ts"
import * as Automations from "./services/automations/Automations.ts"
import * as Files from "./services/Files.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Messages from "./services/Messages.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as Mcp from "./mcp/index.ts"
import * as Ports from "./services/Ports.ts"
import * as Projects from "./services/Projects.ts"
import * as PullRequestWatcher from "./services/PullRequestWatcher.ts"
import * as RemoteAccess from "./remote/access.ts"
import * as RemoteServer from "./remote/server.ts"
import { applyServeConfig, serveConfig } from "./serve.ts"
import { pairingUrl } from "../shared/remote.ts"
import * as Secrets from "./services/Secrets.ts"
import * as Search from "./services/Search.ts"
import * as Settings from "./services/Settings.ts"
import * as Terminals from "./services/Terminals.ts"
import * as ThreadNaming from "./services/ThreadNaming.ts"
import * as TinyVm from "./services/tinyVm/TinyVm.ts"
import * as Threads from "./services/Threads.ts"
import * as Updates from "./services/Updates.ts"
import * as Worktrees from "./services/Worktrees.ts"
import icon from "../../assets/icon.png?asset"

// Without this, launching `electron out/main/index.js` names the app "Electron" and userData moves.
app.setName("kkcode")
// Windows shows notifications only for the AUMID on the Start Menu shortcut, which the installer sets to the appId.
if (process.platform === "win32") app.setAppUserModelId("dev.kkcode.app")
// `kkcode serve` (or KKCODE_SERVE=1) runs this same binary as a headless cloud: no window, the remote
// listener on, and pairing printed to stdout. It needs its own KKCODE_USER_DATA, which the lock below enforces.
const serve = (() => {
  try {
    return serveConfig(process.argv, process.env)
  } catch (error) {
    // Electron keeps the process alive after a throw at load, so a service manager would never see the failure.
    console.error(`kkcode serve: ${error instanceof Error ? error.message : String(error)}`)
    return process.exit(1)
  }
})()
// Lets several instances run side by side during development and testing.
const userDataOverride = process.env["KKCODE_USER_DATA"]
if (userDataOverride) app.setPath("userData", userDataOverride)
// Electron keys the lock on userData. A second process on the same database would run its own pollers and
// agents, and the threads it starts never reach the first process's window.
if (!app.requestSingleInstanceLock()) {
  console.error(`kkcode is already running on ${app.getPath("userData")}. Set KKCODE_USER_DATA to run another.`)
  // A desktop launch hands off to the running app, but a cloud that cannot start has failed, and its service manager must see that.
  app.exit(serve ? 1 : 0)
}
const mockClaude = process.env["KKCODE_MOCK_CLAUDE"]
if (
  mockClaude !== undefined &&
  mockClaude !== "usage-limit" &&
  mockClaude !== "org-spend-limit" &&
  mockClaude !== "todos"
)
  throw new Error("KKCODE_MOCK_CLAUDE must be usage-limit, org-spend-limit or todos")
if (mockClaude !== undefined && !userDataOverride) throw new Error("Claude simulation requires KKCODE_USER_DATA")
const mockResetMs = Number(process.env["KKCODE_MOCK_RESET_MS"] ?? 60000)
if (mockClaude !== undefined && (!Number.isFinite(mockResetMs) || mockResetMs < 0 || mockResetMs > 3600000))
  throw new Error("KKCODE_MOCK_RESET_MS must be between 0 and 3600000")

protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_PROTOCOL, privileges: { standard: true, secure: true } },
  // `stream` lets <video> and <audio> seek with Range requests.
  { scheme: GITHUB_ASSET_PROTOCOL, privileges: { standard: true, secure: true, stream: true } },
  { scheme: PROJECT_FILE_PROTOCOL, privileges: { standard: true, secure: true, stream: true } },
])

/** Serves `kkcode-attachment://file/<encoded absolute path>`, only for files inside the attachments dir. */
const serveAttachments = () =>
  protocol.handle(ATTACHMENT_PROTOCOL, (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1))
    if (!isInside(Attachments.attachmentsRoot(), path)) return new Response(null, { status: 403 })
    return net.fetch(pathToFileURL(path).toString())
  })

type AppRuntime = ManagedRuntime.ManagedRuntime<GitHub.GitHub | Files.Files, unknown>

const rangeOf = (request: Request): RequestInit => {
  const range = request.headers.get("range")
  return range === null ? {} : { headers: { range } }
}

/**
 * Serves `kkcode-github-asset://asset/<id>` from `github.com/user-attachments/assets/<id>`, which private
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
 * Serves `kkcode-file://root/<encoded root>/<path>` for files inside a project root or worktree. The CSP
 * sandbox runs every served document in an opaque origin without popups or top navigation, however it is
 * embedded, so an HTML file can run its scripts but never reach the app.
 */
const serveProjectFiles = (runtime: AppRuntime) =>
  protocol.handle(PROJECT_FILE_PROTOCOL, async (request) => {
    const target = projectFileRequest(request.url)
    if (target === null) return new Response(null, { status: 404 })
    const file = await runtime
      .runPromise(Effect.flatMap(Files.Files, (files) => files.resolve(target.root, target.path)))
      .catch(() => null)
    if (file === null) return new Response(null, { status: 403 })
    const response = await net.fetch(pathToFileURL(file).toString(), rangeOf(request))
    const headers = new Headers(response.headers)
    headers.set("content-security-policy", "sandbox allow-scripts")
    return new Response(response.body, { status: response.status, headers })
  })

const makeAppLayer = (dbPath: string, sbxConfigPath: string) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer),
    ),
    Messages.layer,
    Attachments.layer,
    Search.layer,
    Files.layer,
  )
  const naming =
    mockClaude === undefined
      ? ThreadNaming.layer
      : Layer.succeed(ThreadNaming.ThreadNaming, { nameFromPrompt: () => Effect.void })
  const claude = mockClaude === undefined ? ClaudeProvider.layer : usageLimitLayer(mockClaude, mockResetMs)
  const remoteAccess = RemoteAccess.layer.pipe(Layer.provide(Secrets.layer))
  const tinyVm = TinyVm.layer({ configPath: sbxConfigPath, env: process.env })
  const features = Layer.mergeAll(Mcp.credentialsLayer, Ports.layer, naming, remoteAccess, tinyVm).pipe(
    Layer.provide(domain),
  )
  // A cloud has no app to update in place; it is replaced as a binary, so the updater never starts there.
  const updates = serve
    ? Layer.succeed(Updates.Updates, Updates.Updates.of({ ready: Effect.succeed(null), install: Effect.void }))
    : Updates.layer
  const agents = AgentRunner.layer.pipe(Layer.provideMerge(Layer.mergeAll(domain, features)))
  // The MCP server's tools start turns and ask for secrets, so it sits above the runner.
  const services = Layer.mergeAll(
    Automations.layer,
    AutoArchive.layer,
    PullRequestWatcher.layer,
    updates,
    Mcp.serverLayer,
    AgentLogins.layer,
  ).pipe(Layer.provideMerge(agents))
  // The remote listener dispatches every rpc method, so it sits above everything the handlers use.
  // A cloud's address is written below it, so the listener's first read of its settings already has it.
  return RemoteServer.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(serve ? applyServeConfig(serve) : Effect.void)),
    Layer.provideMerge(services),
    Layer.provide(Layer.mergeAll(claude, CodexProvider.layer, MuseProvider.layer)),
    Layer.provideMerge(makeEventsLayer()),
    Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Favicons.layer)),
    Layer.provide(Db.layer(dbPath)),
    Layer.provide(NodeServices.layer),
  )
}

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

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: "#0a0a0a",
    title: "kkcode",
    icon,
    // The renderer draws its own title bar around the traffic lights (see TitleBar.tsx).
    ...(process.platform === "darwin" && { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 13 } }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      webviewTag: true,
    },
  })
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

  void window.loadURL(appUrl)
}

const LISTEN_TIMEOUT_MS = 5000

/**
 * Waits until the `kkcode serve` listener is bound, then prints the pairing URL per reachable host.
 * Stdout is the daemon's interface: a terminal, launchd or systemd reads it.
 */
const startCloud = async (
  runtime: ManagedRuntime.ManagedRuntime<RemoteAccess.RemoteAccess, unknown>,
  userData: string,
) => {
  const deadline = Date.now() + LISTEN_TIMEOUT_MS
  for (;;) {
    const status = await runtime.runPromise(RemoteAccess.RemoteAccess.use((remote) => remote.status))
    if (status.listening) break
    if (status.listenError) throw new Error(`remote listener failed: ${status.listenError}`)
    if (Date.now() > deadline) throw new Error("remote listener did not start in time")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const pairing = await runtime.runPromise(RemoteAccess.RemoteAccess.use((remote) => remote.pairing))
  const lines = [
    "kkcode cloud",
    `data: ${userData}`,
    "pair a client with one of:",
    ...pairing.hosts.map((host) => `  ${pairingUrl(host, pairing.port, pairing.token)}`),
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData")
  // Where `sbx login` keeps its login on macOS and Linux.
  const sbxConfigPath = join(app.getPath("appData"), "sbx", "config.json")
  const runtime = ManagedRuntime.make(makeAppLayer(join(userData, "kkcode.sqlite"), sbxConfigPath))
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
  if (serve) {
    app.dock?.hide()
    process.on("SIGINT", () => app.quit())
    process.on("SIGTERM", () => app.quit())
    try {
      await startCloud(runtime, userData)
    } catch (cause) {
      console.error("kkcode serve failed", cause)
      app.exit(1)
    }
    return
  }
  registerIpc(runtime, appUrl)
  app.dock?.setIcon(icon)
  serveAttachments()
  serveGitHubAssets(runtime)
  serveProjectFiles(runtime)
  limitBrowserPermissions()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) bringToFront(window)
    else createWindow()
  })
  createWindow()
})

app.on("window-all-closed", () => {
  if (!serve && process.platform !== "darwin") app.quit()
})
