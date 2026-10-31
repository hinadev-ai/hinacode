import { isAbsolute, relative, sep } from "node:path"
import {
  ATTACHMENT_PROTOCOL,
  EXTERNAL_IMAGE_PROTOCOL,
  GITHUB_ASSET_PROTOCOL,
  PROJECT_FILE_PROTOCOL,
} from "../shared/channels.ts"

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

const isLocalHost = (hostname: string): boolean => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return true
  if (host.includes(":")) {
    if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true
    if (!host.startsWith("::ffff:")) return false
    const mapped = host.slice("::ffff:".length)
    if (isLocalHost(mapped)) return true
    const groups = mapped.split(":").map((group) => Number.parseInt(group, 16))
    if (groups.length !== 2 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff))
      return false
    const [high = 0, low = 0] = groups
    return isLocalHost(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  const octets = host.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return false
  const [a = Number.NaN, b = Number.NaN] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168)
  )
}

export const externalImageTarget = (url: string): string | null => {
  const parsed = URL.parse(url)
  if (!parsed || !EXTERNAL_PROTOCOLS.has(parsed.protocol) || isLocalHost(parsed.hostname)) return null
  parsed.hash = ""
  parsed.username = ""
  parsed.password = ""
  return parsed.href
}

export const externalImageRequest = (url: string): string | null => {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== `${EXTERNAL_IMAGE_PROTOCOL}:` || parsed.host !== "image") return null
  try {
    return externalImageTarget(decodeURIComponent(parsed.pathname.slice(1)))
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
