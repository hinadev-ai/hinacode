import { isAbsolute, relative, sep } from "node:path"

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

/** Only the app document in the top-level frame may call RPC; `frame` is `IpcMainInvokeEvent.senderFrame`. */
export const isTrustedSender = (frame: { url: string; parent: unknown } | null, appUrl: string): boolean =>
  frame !== null && frame.parent === null && isAppDocument(frame.url, appUrl)

/** Whether the absolute `path` is `root` or lies under it. Lexical only, so resolve symlinks first. */
export const isInside = (root: string, path: string): boolean => {
  const inside = relative(root, path)
  return isAbsolute(path) && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}
