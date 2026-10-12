import { Cache, Context, Effect, Layer } from "effect"

const TIMEOUT_MS = 5000
const PAGE_LIMIT = 512 * 1024
const ICON_LIMIT = 100 * 1024

const isWeb = (url: URL) => url.protocol === "http:" || url.protocol === "https:"

/** GETs `url` without credentials. Null when it fails, redirects off the web, or is not a 2xx. */
const get = async (url: URL) => {
  const response = await fetch(url, {
    redirect: "follow",
    credentials: "omit",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null)
  if (!response?.ok || !isWeb(new URL(response.url))) return null
  return response
}

/** Reads at most `limit + 1` bytes, so a caller can tell a body that fits from one that does not. */
const readUpTo = async (response: Response, limit: number) => {
  const chunks: Array<Uint8Array> = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    chunks.push(chunk)
    size += chunk.byteLength
    if (size > limit) break
  }
  await response.body?.cancel().catch(() => undefined)
  return Buffer.concat(chunks).subarray(0, limit + 1)
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined)

const ICON_RELS = new Set(["icon", "apple-touch-icon"])

/** The first `<link rel="icon" | "shortcut icon" | "apple-touch-icon">` href in `html`, resolved against `base`. */
const linkedIcon = (html: string, base: string) => {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rels = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/)
    const href = attribute(tag, "href")?.replaceAll("&amp;", "&").trim()
    if (href && rels.some((rel) => ICON_RELS.has(rel))) return URL.parse(href, base)
  }
  return null
}

const iconType = (response: Response, url: URL) => {
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  if (type.startsWith("image/")) return type
  if (type === "application/octet-stream" && url.pathname.endsWith(".ico")) return "image/x-icon"
  return null
}

const fetchIcon = async (url: URL) => {
  if (!isWeb(url)) return null
  const response = await get(url)
  const type = response && iconType(response, new URL(response.url))
  if (!response || !type) return null
  const body = await readUpTo(response, ICON_LIMIT)
  if (body.byteLength === 0 || body.byteLength > ICON_LIMIT) return null
  return `data:${type};base64,${body.toString("base64")}`
}

const lookup = async (origin: string) => {
  const page = await get(new URL("/", origin))
  const html = page ? (await readUpTo(page, PAGE_LIMIT)).subarray(0, PAGE_LIMIT).toString("utf8") : ""
  const linked = page && linkedIcon(html, page.url)
  return (linked && (await fetchIcon(linked))) ?? (await fetchIcon(new URL("/favicon.ico", origin)))
}

/** Site icons for links in messages, as data URLs because the renderer's CSP only loads images from the app. */
export class Favicons extends Context.Service<
  Favicons,
  {
    /** The icon of `url`'s origin, or null when it is not http(s) or has no usable icon. Never fails. */
    readonly favicon: (url: string) => Effect.Effect<string | null>
  }
>()("kkcode/Favicons") {}

const make = Effect.gen(function* () {
  // Kept for the app's lifetime, misses included; concurrent gets for one origin share a lookup.
  const icons = yield* Cache.make({
    lookup: (origin: string) => Effect.promise(() => lookup(origin).catch(() => null)),
    capacity: Number.MAX_SAFE_INTEGER,
  })

  return Favicons.of({
    favicon: (url) => {
      const parsed = URL.parse(url)
      return parsed && isWeb(parsed) ? Cache.get(icons, parsed.origin) : Effect.succeed(null)
    },
  })
})

export const layer = Layer.effect(Favicons, make)
