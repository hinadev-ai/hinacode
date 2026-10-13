import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { BrowserWindow, shell } from "electron"
import { externalUrl, isAppDocument, lockDownWebview } from "./security.ts"
import icon from "../../assets/icon.png?asset"

export const appUrl =
  process.env["ELECTRON_RENDERER_URL"] ?? pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href

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

/** Windows opened for a single project, by project id. The window opened at launch shows every project. */
const projectWindows = new Map<string, BrowserWindow>()

/** `projectId` scopes the window to one project; the renderer reads it from the `project` query parameter. */
export const createWindow = (projectId?: string) => {
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
    if (!event.isMainFrame || !isAppDocument(event.url, appUrl)) event.preventDefault()
  }
  window.webContents.on("will-frame-navigate", stayInApp)
  window.webContents.on("will-redirect", stayInApp)
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!lockDownWebview(preferences as Record<string, unknown>, params)) event.preventDefault()
  })
  window.webContents.on("did-attach-webview", (_event, page) => keepOnTheWeb(page))

  const url = new URL(appUrl)
  if (projectId !== undefined) {
    url.searchParams.set("project", projectId)
    projectWindows.set(projectId, window)
    window.on("closed", () => projectWindows.delete(projectId))
  }
  void window.loadURL(url.href)
}

/** Focuses the project's window, or opens one. */
export const openProjectWindow = (projectId: string) => {
  const existing = projectWindows.get(projectId)
  if (!existing) return createWindow(projectId)
  if (existing.isMinimized()) existing.restore()
  existing.focus()
}

/** A deleted project's window has nothing left to show. */
export const closeProjectWindow = (projectId: string) => projectWindows.get(projectId)?.close()
