import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { app, BrowserWindow, net, protocol, shell } from "electron"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as ClaudeProvider from "./agents/claude/index.ts"
import { usageLimitLayer } from "./agents/claude/mock.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import * as Db from "./db/client.ts"
import { eventsLayer, registerIpc } from "./ipc.ts"
import { externalUrl, isAppDocument, isInside } from "./security.ts"
import { ATTACHMENT_PROTOCOL } from "../shared/channels.ts"
import * as AgentAccounts from "./services/AgentAccounts.ts"
import * as AgentLogins from "./services/AgentLogins.ts"
import * as AgentRunner from "./services/AgentRunner.ts"
import * as Attachments from "./services/Attachments.ts"
import * as Automations from "./services/automations/Automations.ts"
import * as Files from "./services/Files.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Messages from "./services/Messages.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as Mcp from "./mcp/index.ts"
import * as Ports from "./services/Ports.ts"
import * as Projects from "./services/Projects.ts"
import * as Search from "./services/Search.ts"
import * as Settings from "./services/Settings.ts"
import * as Terminals from "./services/Terminals.ts"
import * as ThreadNaming from "./services/ThreadNaming.ts"
import * as Threads from "./services/Threads.ts"
import * as Worktrees from "./services/Worktrees.ts"

// Without this, launching `electron out/main/index.js` names the app "Electron" and userData moves.
app.setName("kkcode")
// Lets several instances run side by side during development and testing.
const userDataOverride = process.env["KKCODE_USER_DATA"]
if (userDataOverride) app.setPath("userData", userDataOverride)
const mockClaude = process.env["KKCODE_MOCK_CLAUDE"]
if (mockClaude !== undefined && mockClaude !== "usage-limit" && mockClaude !== "org-spend-limit")
  throw new Error("KKCODE_MOCK_CLAUDE must be usage-limit or org-spend-limit")
if (mockClaude !== undefined && !userDataOverride) throw new Error("Claude simulation requires KKCODE_USER_DATA")
const mockResetMs = Number(process.env["KKCODE_MOCK_RESET_MS"] ?? 60000)
if (mockClaude !== undefined && (!Number.isFinite(mockResetMs) || mockResetMs < 0 || mockResetMs > 3600000))
  throw new Error("KKCODE_MOCK_RESET_MS must be between 0 and 3600000")

protocol.registerSchemesAsPrivileged([{ scheme: ATTACHMENT_PROTOCOL, privileges: { standard: true, secure: true } }])

/** Serves `kkcode-attachment://file/<encoded absolute path>`, only for files inside the attachments dir. */
const serveAttachments = () =>
  protocol.handle(ATTACHMENT_PROTOCOL, (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1))
    if (!isInside(Attachments.attachmentsRoot(), path)) return new Response(null, { status: 403 })
    return net.fetch(pathToFileURL(path).toString())
  })

const makeAppLayer = (dbPath: string, accountsRoot: string) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer(accountsRoot)),
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
  const features = Layer.mergeAll(Mcp.credentialsLayer, Ports.layer, Terminals.layer, naming).pipe(
    Layer.provide(domain),
  )
  const agents = AgentRunner.layer.pipe(Layer.provideMerge(Layer.mergeAll(domain, features)))
  // The MCP server's tools start turns and ask for secrets, so it sits above the runner.
  return Layer.mergeAll(Automations.layer, Mcp.serverLayer, AgentLogins.layer).pipe(
    Layer.provideMerge(agents),
    Layer.provide(Layer.mergeAll(claude, CodexProvider.layer, eventsLayer)),
    Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Favicons.layer)),
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
  const userData = app.getPath("userData")
  const runtime = ManagedRuntime.make(makeAppLayer(join(userData, "kkcode.sqlite"), join(userData, "accounts")))
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
