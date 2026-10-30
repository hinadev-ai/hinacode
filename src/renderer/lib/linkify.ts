import type { GitHubRepository } from "../../shared/github.ts"
import { linkPullRequestNumbers } from "./pullRequestRefs.ts"

export type Segment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "link"; readonly text: string; readonly href: string }

const URL_PATTERN = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>]+/giu
const TRAILING_PUNCTUATION = /[.,;:!?*_~'"]$/

const count = (text: string, char: string) => text.split(char).length - 1

const trimTrailing = (url: string) => {
  let end = url
  while (TRAILING_PUNCTUATION.test(end) || (end.endsWith(")") && count(end, ")") > count(end, "("))) {
    end = end.slice(0, -1)
  }
  return end
}

export const linkify = (text: string, repository: GitHubRepository | null = null): Array<Segment> => {
  const segments: Array<Segment> = []
  const pushText = (piece: string) => {
    if (piece === "") return
    if (repository) segments.push(...linkPullRequestNumbers(piece, repository))
    else segments.push({ type: "text", text: piece })
  }
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimTrailing(match[0])
    if (!/^https?:\/\/./i.test(url)) continue
    pushText(text.slice(last, match.index))
    segments.push({ type: "link", text: url, href: url })
    last = match.index + url.length
  }
  pushText(text.slice(last))
  return segments
}

const FAVICONS_PER_MESSAGE = 20

export const faviconOrigins = (texts: ReadonlyArray<string>, limit = FAVICONS_PER_MESSAGE): ReadonlySet<string> => {
  const origins = new Set<string>()
  for (const segment of texts.flatMap((text) => linkify(text))) {
    if (origins.size === limit) break
    const origin = segment.type === "link" ? URL.parse(segment.href)?.origin : undefined
    if (origin) origins.add(origin)
  }
  return origins
}
