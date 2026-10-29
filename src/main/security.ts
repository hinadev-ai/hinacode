import { isAbsolute, relative, sep } from "node:path"
import { ATTACHMENT_PROTOCOL, GITHUB_ASSET_PROTOCOL, PROJECT_FILE_PROTOCOL } from "../shared/channels.ts"

const EXTERNAL_PROTOCOLS = new Set(["https:", "http:"])

export const externalUrl = (url: string): string | null => {
  const parsed = URL.parse(url)
  return parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}

export const isAppDocument = (url: string, appUrl: string): boolean => {
  const target = URL.parse(url)
  const app = new URL(appUrl)
  if (!target || target.protocol !== app.protocol || target.host !== app.host) return false
  return app.protocol !== "file:" || target.pathname === app.pathname
}

export const isAllowedNavigation = (url: string, isMainFrame: boolean, appUrl: string): boolean =>
  isMainFrame ? isAppDocument(url, appUrl) : URL.parse(url)?.protocol === `${PROJECT_FILE_PROTOCOL}:`

export const isTrustedSender = (frame: { url: string; parent: unknown } | null, appUrl: string): boolean =>
  frame !== null && frame.parent === null && isAppDocument(frame.url, appUrl)

export const isInside = (root: string, path: string): boolean => {
  const inside = relative(root, path)
  return isAbsolute(path) && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

export const BROWSER_PARTITION = "persist:browser"

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

export const githubAssetId = (url: string): string | null => {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== `${GITHUB_ASSET_PROTOCOL}:` || parsed.host !== "asset") return null
  const id = parsed.pathname.slice(1)
  return UUID.test(id) ? id : null
}

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

export const attachmentRequest = (url: string): { path: string; environment: string | null } | null => {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== `${ATTACHMENT_PROTOCOL}:` || parsed.host !== "file") return null
  try {
    return { path: decodeURIComponent(parsed.pathname.slice(1)), environment: parsed.searchParams.get("environment") }
  } catch {
    return null
  }
}
