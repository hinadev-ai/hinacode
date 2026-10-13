import { RiChat3Line, RiErrorWarningLine, RiFileTextLine } from "react-icons/ri"
import type { FileSearchHit, ThreadSearchHit } from "../../shared/domain.ts"
import { ProviderIcon } from "../components/ProviderIcon.tsx"
import { errorMessage } from "../lib/errorMessage.ts"
import { findPattern } from "../lib/find.ts"
import { callPromise, RpcError } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { MAX_ITEMS_PER_GROUP, type RankedGroup, type RankedItem } from "./rank.ts"
import { openFile } from "./sources.tsx"
import type { PaletteContext, PaletteGroup, PaletteItem, PaletteSource } from "./types.ts"

const iconClass = "size-3.5 shrink-0 text-muted-foreground"

/** Starting a ripgrep per keystroke would pile up processes, so file search waits for a pause. */
const FILES_DEBOUNCE_MS = 150

const threadItem = (hit: ThreadSearchHit, query: string, ctx: PaletteContext): PaletteItem => {
  const provider = ctx.threads[hit.threadId]?.provider
  return {
    id: `message:${hit.messageId}`,
    group: "threads",
    title: hit.threadTitle,
    subtitle: hit.snippet,
    icon: provider ? <ProviderIcon provider={provider} /> : <RiChat3Line aria-hidden className={iconClass} />,
    run: () => {
      void ctx.navigate({ to: "/thread/$threadId", params: { threadId: hit.threadId } })
      useUi.getState().openFind(hit.threadId, query, hit.messageId)
    },
  }
}

const fileItem = (hit: FileSearchHit, ctx: PaletteContext): PaletteItem => ({
  id: `match:${hit.path}:${hit.line}`,
  group: "files",
  title: `${hit.path.slice(hit.path.lastIndexOf("/") + 1)}:${hit.line}`,
  subtitle: hit.text,
  icon: <RiFileTextLine aria-hidden className={iconClass} />,
  run: () => openFile(ctx, hit.path),
})

const ripgrepMissingItem = (): PaletteItem => ({
  id: "match:ripgrep-missing",
  group: "files",
  title: m.search_ripgrep_missing(),
  icon: <RiErrorWarningLine aria-hidden className={iconClass} />,
  run: () => {},
})

const logFailure = (what: string) => (cause: unknown) => {
  console.error(`${what}: ${errorMessage(cause)}`)
  return []
}

/**
 * Share only pending requests when the palette asks again during a streamed turn. Settled answers
 * are discarded so reopening or repeating a search reads current messages and workspace files.
 */
let lastThreads: { query: string; items: Promise<ReadonlyArray<ThreadSearchHit>> } | null = null
let lastFiles: { key: string; items: Promise<ReadonlyArray<PaletteItem>> } | null = null

export const threadSearchSource: PaletteSource = {
  group: "threads",
  items: (query, ctx) => {
    if (query === "") return []
    if (lastThreads?.query !== query) {
      const request = { query, items: callPromise("search.threads", { query }).catch(logFailure("Search failed")) }
      lastThreads = request
      void request.items.then(() => {
        if (lastThreads === request) lastThreads = null
      })
    }
    return lastThreads.items.then((hits) => hits.map((hit) => threadItem(hit, query, ctx)))
  },
}

const searchFiles = async (
  ctx: PaletteContext,
  threadId: string,
  query: string,
  key: string,
): Promise<ReadonlyArray<PaletteItem>> => {
  await new Promise((resolve) => setTimeout(resolve, FILES_DEBOUNCE_MS))
  if (lastFiles?.key !== key) return []
  return callPromise("search.files", { threadId, query }).then(
    (hits) => hits.map((hit) => fileItem(hit, ctx)),
    (cause: unknown) =>
      cause instanceof RpcError && cause.tag === "RipgrepMissingError"
        ? [ripgrepMissingItem()]
        : logFailure("File search failed")(cause),
  )
}

/** Lines in the open thread's workspace. */
export const fileSearchSource: PaletteSource = {
  group: "files",
  items: (query, ctx) => {
    if (query === "" || !ctx.threadId) return []
    const key = `${ctx.threadId}\0${query}`
    if (lastFiles?.key !== key) {
      const request = { key, items: searchFiles(ctx, ctx.threadId, query, key) }
      lastFiles = request
      void request.items.then(() => {
        if (lastFiles === request) lastFiles = null
      })
    }
    return lastFiles.items
  },
}

const matchIndexes = (text: string, pattern: RegExp | null): Array<number> =>
  pattern === null
    ? []
    : [...text.matchAll(pattern)].flatMap((match) =>
        Array.from({ length: match[0].length }, (_, offset) => match.index + offset),
      )

/**
 * Keeps the order main returned, newest message and ripgrep's order, and marks the literal query
 * rather than fuzzy matched characters, since that is what matched.
 */
export function rankLiteral(items: ReadonlyArray<PaletteItem>, query: string): ReadonlyArray<RankedGroup> {
  const pattern = findPattern(query)
  const groups = new Map<PaletteGroup, Array<RankedItem>>()
  for (const item of items) {
    const group = groups.get(item.group) ?? []
    if (group.length < MAX_ITEMS_PER_GROUP) {
      group.push({
        item,
        titleMatches: matchIndexes(item.title, pattern),
        subtitleMatches: matchIndexes(item.subtitle ?? "", pattern),
      })
    }
    groups.set(item.group, group)
  }
  return [...groups].map(([group, entries]) => ({ group, items: entries }))
}
