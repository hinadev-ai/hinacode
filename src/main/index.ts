import { join, relative, isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { app, BrowserWindow, net, protocol, shell } from "electron"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as ClaudeProvider from "./agents/claude/index.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import * as Db from "./db/client.ts"
import { eventsLayer, registerIpc } from "./ipc.ts"
import { externalUrl, isAppDocument } from "./security.ts"
import { ATTACHMENT_PROTOCOL } from "../shared/channels.ts"
import * as AgentRunner from "./services/AgentRunner.ts"
import * as Attachments from "./services/Attachments.ts"
import * as Automations from "./services/automations/Automations.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Messages from "./services/Messages.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as Mcp from "./mcp/index.ts"
import * as Ports from "./services/Ports.ts"
import * as Projects from "./services/Projects.ts"
import * as Settings from "./services/Settings.ts"
import * as ThreadNaming from "./services/ThreadNaming.ts"
import * as Threads from "./services/Threads.ts"
import * as Worktrees from "./services/Worktrees.ts"

// Without this, launching `electron out/main/index.js` names the app "Electron" and userData moves.
app.setName("kkcode")
// Lets several instances run side by side during development and testing.
const userDataOverride = process.env["KKCODE_USER_DATA"]
if (userDataOverride) app.setPath("userData", userDataOverride)

protocol.registerSchemesAsPrivileged([{ scheme: ATTACHMENT_PROTOCOL, privileges: { standard: true, secure: true } }])

/** Serves `kkcode-attachment://file/<encoded absolute path>`, only for files inside the attachments dir. */
const serveAttachments = () =>
  protocol.handle(ATTACHMENT_PROTOCOL, (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1))
    const inside = relative(Attachments.attachmentsRoot(), path)
    if (!isAbsolute(path) || inside.startsWith("..") || isAbsolute(inside)) {
      return new Response(null, { status: 403 })
    }
    return net.fetch(pathToFileURL(path).toString())
  })

const makeAppLayer = (dbPath: string) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(Layer.provideMerge(Worktrees.layer), Layer.provideMerge(Projects.layer)),
    Settings.layer,
    Messages.layer,
    Attachments.layer,
  )
  const features = Layer.mergeAll(Mcp.credentialsLayer, Ports.layer, ThreadNaming.layer).pipe(Layer.provide(domain))
  const agents = AgentRunner.layer.pipe(Layer.provideMerge(Layer.mergeAll(domain, features)))
  // The MCP server's tools start turns and ask for secrets, so it sits above the runner.
  return Layer.mergeAll(Automations.layer, Mcp.serverLayer).pipe(
    Layer.provideMerge(agents),
    Layer.provide(Layer.mergeAll(ClaudeProvider.layer, CodexProvider.layer, Git.layer, eventsLayer)),
    Layer.provideMerge(Layer.mergeAll(GitHub.layer, Favicons.layer)),
    Layer.provide(Db.layer(dbPath)),
    Layer.provide(NodeServices.layer),
  )
}

const QUIT_TIMEOUT_MS = 5000

const appUrl =
  process.env["ELECTRON_RENDERER_URL"] ?? pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: "#0a0a0a",
    title: "kkcode",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external) void shell.openExternal(external)
    return { action: "deny" }
  })
  const stayInApp = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!event.isMainFrame || !isAppDocument(event.url, appUrl)) event.preventDefault()
  }
  window.webContents.on("will-frame-navigate", stayInApp)
  window.webContents.on("will-redirect", stayInApp)

  void window.loadURL(appUrl)
}

app.whenReady().then(async () => {
  const runtime = ManagedRuntime.make(makeAppLayer(join(app.getPath("userData"), "kkcode.sqlite")))
  // Build the layer (open the database, run migrations) before the renderer can call in.
  await runtime.runPromise(Effect.void)
  registerIpc(runtime, appUrl)
  serveAttachments()
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
