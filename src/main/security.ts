import { isAbsolute, relative, sep } from "node:path"
import { GITHUB_ASSET_PROTOCOL, PROJECT_FILE_PROTOCOL } from "../shared/channels.ts"

const EXTERNAL_PROTOCOLS = new Set(["https:", "http:"])

/** Returns the URL to hand to `shell.openExternal`, or null when the OS must not open it. */
export const externalUrl = (url: string): string | null => {
  const parsed = URL.parse(url)
  return parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}

/**
 * Whether `url` is the renderer document: the packaged `index.html` itself, or any page on the
 * electron-vite dev server origin when `appUrl` is that server.
 */
export const isAppDocument = (url: string, appUrl: string): boolean => {
  const target = URL.parse(url)
  const app = new URL(appUrl)
  if (!target || target.protocol !== app.protocol || target.host !== app.host) return false
  return app.protocol !== "file:" || target.pathname === app.pathname
}

/**
 * Whether a frame of the app window may navigate to `url`. The top frame stays on the app document, and a
 * subframe may only load project files, which `kkcode-file` serves under a CSP sandbox.
 */
export const isAllowedNavigation = (url: string, isMainFrame: boolean, appUrl: string): boolean =>
  isMainFrame ? isAppDocument(url, appUrl) : URL.parse(url)?.protocol === `${PROJECT_FILE_PROTOCOL}:`

/** Only the app document in the top-level frame may call RPC; `frame` is `IpcMainInvokeEvent.senderFrame`. */
export const isTrustedSender = (frame: { url: string; parent: unknown } | null, appUrl: string): boolean =>
  frame !== null && frame.parent === null && isAppDocument(frame.url, appUrl)

/** Whether the absolute `path` is `root` or lies under it. Lexical only, so resolve symlinks first. */
export const isInside = (root: string, path: string): boolean => {
  const inside = relative(root, path)
  return isAbsolute(path) && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

/** The session the in-app browser's pages run in, apart from the app's own cookies and storage. */
export const BROWSER_PARTITION = "persist:browser"

/**
 * Settles a `<webview>`'s preferences before it attaches, from `will-attach-webview`: no preload, no Node,
 * sandboxed, in the browser session. Returns false when its first URL is not http(s), to refuse it.
 */
export const lockDownWebview = (preferences: Record<string, unknown>, params: Record<string, string>): boolean => {
  delete preferences["preload"]
  delete preferences["preloadURL"]
  Object.assign(preferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    partition: BROWSER_PARTITION,
  })
  params["partition"] = BROWSER_PARTITION
  return externalUrl(params["src"] ?? "") !== null
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

/** The attachment id a `kkcode-github-asset://asset/<id>` request names, or null for anything else. */
export const githubAssetId = (url: string): string | null => {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== `${GITHUB_ASSET_PROTOCOL}:` || parsed.host !== "asset") return null
  const id = parsed.pathname.slice(1)
  return UUID.test(id) ? id : null
}

/**
 * The root and relative path a `kkcode-file://root/<encoded root>/<path>` request names, or null when it is
 * malformed. Says nothing about whether the path stays inside the root; `Files.resolve` checks that.
 */
export const projectFileRequest = (url: string): { root: string; path: string } | null => {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== `${PROJECT_FILE_PROTOCOL}:` || parsed.host !== "root") return null
  const [root, ...segments] = parsed.pathname.slice(1).split("/")
  try {
    return root ? { root: decodeURIComponent(root), path: segments.map(decodeURIComponent).join("/") } : null
  } catch {
    return null
  }
}
