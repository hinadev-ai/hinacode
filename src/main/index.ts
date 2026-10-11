import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { app, BrowserWindow, shell } from "electron"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as Db from "./db/client.ts"
import { registerIpc } from "./ipc.ts"
import * as Mcp from "./mcp/index.ts"
import * as Projects from "./services/Projects.ts"
import * as Settings from "./services/Settings.ts"
import * as Threads from "./services/Threads.ts"
import * as Worktrees from "./services/Worktrees.ts"

// Without this, launching `electron out/main/index.js` names the app "Electron" and userData moves.
app.setName("kkcode")
// Lets several instances run side by side during development and testing.
const userDataOverride = process.env["KKCODE_USER_DATA"]
if (userDataOverride) app.setPath("userData", userDataOverride)

const makeAppLayer = (dbPath: string) =>
  Layer.mergeAll(
    Threads.layer.pipe(Layer.provideMerge(Projects.layer)),
    Worktrees.layer,
    Settings.layer,
    Mcp.layer,
  ).pipe(Layer.provide(Db.layer(dbPath)), Layer.provide(NodeFileSystem.layer))

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
  window.once("ready-to-show", () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"))
}

app.whenReady().then(async () => {
  const runtime = ManagedRuntime.make(makeAppLayer(join(app.getPath("userData"), "kkcode.sqlite")))
  // Build the layer (open the database, run migrations) before the renderer can call in.
  await runtime.runPromise(Effect.void)
  registerIpc(runtime)
  app.on("before-quit", () => void runtime.dispose())
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
