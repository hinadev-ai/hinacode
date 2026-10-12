export type Segment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "link"; readonly text: string; readonly href: string }

const URL_PATTERN = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>]+/giu
const TRAILING_PUNCTUATION = /[.,;:!?*_~'"]$/

const count = (text: string, char: string) => text.split(char).length - 1

/** Drops trailing punctuation the way GFM autolinks do: a `)` stays only when it closes a `(` in the url. */
const trimTrailing = (url: string) => {
  let end = url
  while (TRAILING_PUNCTUATION.test(end) || (end.endsWith(")") && count(end, ")") > count(end, "("))) {
    end = end.slice(0, -1)
  }
  return end
}

/** Splits plain text into text and http(s) url segments. Joining every segment's text gives back `text`. */
export const linkify = (text: string): Array<Segment> => {
  const segments: Array<Segment> = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimTrailing(match[0])
    if (!/^https?:\/\/./i.test(url)) continue
    if (match.index > last) segments.push({ type: "text", text: text.slice(last, match.index) })
    segments.push({ type: "link", text: url, href: url })
    last = match.index + url.length
  }
  if (last < text.length) segments.push({ type: "text", text: text.slice(last) })
  return segments
}

/** How many sites one message may ask favicons for, so a message full of links cannot flood the network. */
const FAVICONS_PER_MESSAGE = 20

/** The origins of the first `limit` distinct sites linked across `texts`, in reading order. */
export const faviconOrigins = (texts: ReadonlyArray<string>, limit = FAVICONS_PER_MESSAGE): ReadonlySet<string> => {
  const origins = new Set<string>()
  for (const segment of texts.flatMap((text) => linkify(text))) {
    if (origins.size === limit) break
    const origin = segment.type === "link" ? URL.parse(segment.href)?.origin : undefined
    if (origin) origins.add(origin)
  }
  return origins
}
