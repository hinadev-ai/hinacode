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
import { ChatIcon, FileTextIcon, WarningIcon } from "@hinacode/icons"

const iconClass = "size-3.5 shrink-0 text-muted-foreground"

const SEARCH_DEBOUNCE_MS = 150

const afterTypingPause = () => new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS))

const threadItem = (hit: ThreadSearchHit, query: string, ctx: PaletteContext): PaletteItem => {
  const provider = ctx.threads[hit.threadId]?.provider
  return {
    id: `message:${hit.messageId}`,
    group: "threads",
    title: hit.threadTitle,
    subtitle: hit.snippet,
    icon: provider ? <ProviderIcon provider={provider} /> : <ChatIcon aria-hidden className={iconClass} />,
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
  icon: <FileTextIcon aria-hidden className={iconClass} />,
  run: () => openFile(ctx, hit.path),
})

const ripgrepMissingItem = (): PaletteItem => ({
  id: "match:ripgrep-missing",
  group: "files",
  title: m.search_ripgrep_missing(),
  icon: <WarningIcon aria-hidden className={iconClass} />,
  run: () => {},
})

const logFailure = (what: string) => (cause: unknown) => {
  console.error(`${what}: ${errorMessage(cause)}`)
  return []
}

let lastThreads: { query: string; items: Promise<ReadonlyArray<PaletteItem>> } | null = null
let lastFiles: { key: string; items: Promise<ReadonlyArray<PaletteItem>> } | null = null

const searchThreads = async (query: string, ctx: PaletteContext): Promise<ReadonlyArray<PaletteItem>> => {
  await afterTypingPause()
  if (lastThreads?.query !== query) return []
  return callPromise("search.threads", { query }).then(
    (hits) => hits.map((hit) => threadItem(hit, query, ctx)),
    logFailure("Search failed"),
  )
}

export const threadSearchSource: PaletteSource = {
  group: "threads",
  items: (query, ctx) => {
    if (query === "") {
      lastThreads = null
      return []
    }
    if (lastThreads?.query !== query) lastThreads = { query, items: searchThreads(query, ctx) }
    return lastThreads.items
  },
}

const searchFiles = async (
  ctx: PaletteContext,
  threadId: string,
  query: string,
  key: string,
): Promise<ReadonlyArray<PaletteItem>> => {
  await afterTypingPause()
  if (lastFiles?.key !== key) return []
  return callPromise("search.files", { threadId, query }).then(
    (hits) => hits.map((hit) => fileItem(hit, ctx)),
    (cause: unknown) =>
      cause instanceof RpcError && cause.tag === "RipgrepMissingError"
        ? [ripgrepMissingItem()]
        : logFailure("File search failed")(cause),
  )
}

export const fileSearchSource: PaletteSource = {
  group: "files",
  items: (query, ctx) => {
    if (query === "" || !ctx.threadId) {
      lastFiles = null
      return []
    }
    const key = `${ctx.threadId}\0${query}`
    if (lastFiles?.key !== key) lastFiles = { key, items: searchFiles(ctx, ctx.threadId, query, key) }
    return lastFiles.items
  },
}

const matchIndexes = (text: string, pattern: RegExp | null): Array<number> =>
  pattern === null
    ? []
    : [...text.matchAll(pattern)].flatMap((match) =>
        Array.from({ length: match[0].length }, (_, offset) => match.index + offset),
      )

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
