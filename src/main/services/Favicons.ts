import { Cache, Context, Duration, Effect, Equal, Exit, Hash, Layer, Semaphore } from "effect"

/** Per GET, redirects included. */
const REQUEST_TIMEOUT_MS = 5000
/** For a host's whole lookup: page, icon and every redirect. */
const LOOKUP_TIMEOUT_MS = 8000
const MAX_REDIRECTS = 3
const PAGE_LIMIT_BYTES = 512 * 1024
const ICON_LIMIT_BYTES = 100 * 1024
/** Lookups running at once across the app, however many messages ask. */
const MAX_CONCURRENT_LOOKUPS = 4
/** Hosts remembered; the oldest is forgotten first. */
const CACHE_CAPACITY = 500
/** A miss is retried after this, so a network blip does not hide a site's icon until restart. */
const MISS_TTL = "5 minutes"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const isWeb = (url: URL) => url.protocol === "http:" || url.protocol === "https:"

/**
 * GETs `url` without credentials, following at most `MAX_REDIRECTS` redirects and only to http(s).
 * Null when it fails or is not a 2xx. The returned `url` is where the response came from.
 */
const get = async (url: URL, deadline: AbortSignal) => {
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  let current: URL | null = url
  for (let redirects = 0; current && isWeb(current); redirects++) {
    const response = await fetch(current, { redirect: "manual", credentials: "omit", signal })
    if (!REDIRECT_STATUSES.has(response.status)) return response.ok ? { response, url: current } : null
    await response.body?.cancel()
    const location = response.headers.get("location")
    if (redirects === MAX_REDIRECTS || !location) return null
    current = URL.parse(location, current.href)
  }
  return null
}

/**
 * The body's first `limit` bytes, and whether it was longer. Stops downloading as soon as it passes
 * `limit`, so an endless body costs no more than a full one.
 */
const readUpTo = async (response: Response, limit: number) => {
  const chunks: Array<Uint8Array> = []
  let size = 0
  const reader = response.body?.getReader()
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false }
  while (size <= limit) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel()
  return { bytes: Buffer.concat(chunks).subarray(0, limit), truncated: size > limit }
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined)

const ICON_RELS = new Set(["icon", "apple-touch-icon"])

/** The first `<link rel="icon" | "shortcut icon" | "apple-touch-icon">` href in `html`, resolved against `base`. */
const linkedIcon = (html: string, base: URL) => {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rels = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/)
    const href = attribute(tag, "href")?.replaceAll("&amp;", "&").trim()
    if (href && rels.some((rel) => ICON_RELS.has(rel))) return URL.parse(href, base.href)
  }
  return null
}

const startsWith = (bytes: Buffer, signature: string, offset = 0) =>
  bytes.subarray(offset, offset + signature.length).equals(Buffer.from(signature, "latin1"))

const SVG_ROOT = /^(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i

/** The image type `bytes` actually are, from their magic bytes. Null for anything but PNG, ICO, GIF, JPEG, WebP and SVG. */
const sniffImage = (bytes: Buffer) => {
  if (startsWith(bytes, "\x89PNG\r\n\x1a\n")) return "image/png"
  if (startsWith(bytes, "\x00\x00\x01\x00")) return "image/x-icon"
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif"
  if (startsWith(bytes, "\xff\xd8\xff")) return "image/jpeg"
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp"
  if (!bytes.includes(0) && SVG_ROOT.test(bytes.toString("utf8").replace(/^﻿/, "").trimStart())) {
    return "image/svg+xml"
  }
  return null
}

const ICON_CONTENT_TYPE = /^(?:image\/|application\/octet-stream)/i

const fetchIcon = async (url: URL, deadline: AbortSignal) => {
  const icon = await get(url, deadline)
  if (!icon || !ICON_CONTENT_TYPE.test(icon.response.headers.get("content-type") ?? "")) return null
  const { bytes, truncated } = await readUpTo(icon.response, ICON_LIMIT_BYTES)
  const type = truncated ? null : sniffImage(bytes)
  return type && `data:${type};base64,${bytes.toString("base64")}`
}

const lookup = async (origin: string) => {
  const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
  const page = await get(new URL("/", origin), deadline).catch(() => null)
  const html = page ? (await readUpTo(page.response, PAGE_LIMIT_BYTES)).bytes.toString("utf8") : ""
  const linked = page && linkedIcon(html, page.url)
  const icon = linked && (await fetchIcon(linked, deadline).catch(() => null))
  return icon ?? (await fetchIcon(new URL("/favicon.ico", origin), deadline))
}

/** Site icons for links in messages, as data URLs because the renderer's CSP only loads images from the app. */
export class Favicons extends Context.Service<
  Favicons,
  {
    /** The icon of `url`'s host, or null when it is not http(s) or has no usable icon. Never fails. */
    readonly favicon: (url: string) => Effect.Effect<string | null>
  }
>()("kkcode/Favicons") {}

/** A cache key that equals any other for the same host, so every scheme, port and path shares one lookup. */
class Host implements Equal.Equal {
  readonly hostname: string
  /** The origin of the first url seen for the host, which is the one asked. */
  readonly origin: string
  constructor(hostname: string, origin: string) {
    this.hostname = hostname
    this.origin = origin
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Host && that.hostname === this.hostname
  }
  [Hash.symbol](): number {
    return Hash.string(this.hostname)
  }
}

const make = Effect.gen(function* () {
  const lookups = yield* Semaphore.make(MAX_CONCURRENT_LOOKUPS)
  // Concurrent gets for one host share a lookup.
  const icons = yield* Cache.makeWith(
    (host: Host) =>
      Semaphore.withPermit(
        lookups,
        Effect.promise(() => lookup(host.origin).catch(() => null)),
      ),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== null ? Duration.infinity : MISS_TTL),
    },
  )

  return Favicons.of({
    favicon: (url) => {
      const parsed = URL.parse(url)
      return parsed && isWeb(parsed)
        ? Cache.get(icons, new Host(parsed.hostname.toLowerCase(), parsed.origin))
        : Effect.succeed(null)
    },
  })
})

export const layer = Layer.effect(Favicons, make)
