import { go, type KeysResult } from "fuzzysort"
import type { PaletteGroup, PaletteItem } from "./types.ts"

export interface RankedItem {
  readonly item: PaletteItem
  readonly titleMatches: ReadonlyArray<number>
  readonly subtitleMatches: ReadonlyArray<number>
}

export interface RankedGroup {
  readonly group: PaletteGroup
  readonly items: ReadonlyArray<RankedItem>
}

export const MAX_ITEMS_PER_GROUP = 50

interface Match {
  readonly item: PaletteItem
  readonly result?: KeysResult<PaletteItem>
}

const byScore = (items: ReadonlyArray<PaletteItem>, query: string): ReadonlyArray<Match> => {
  if (query.trim() === "") return items.map((item) => ({ item }))
  return go(query, items, {
    keys: [(item) => item.title, (item) => item.subtitle, (item) => item.keywords?.join(" ")],
    threshold: 0,
    limit: 0,
  }).map((result) => ({ item: result.obj, result }))
}

// FIXME: fuzzysort computes `indexes` on every read, so only shown items read them
const highlight = ({ item, result }: Match): RankedItem => ({
  item,
  titleMatches: result?.[0]?.indexes ?? [],
  subtitleMatches: result?.[1]?.indexes ?? [],
})

export function rankPalette(
  items: ReadonlyArray<PaletteItem>,
  query: string,
  recent: ReadonlyArray<string>,
): ReadonlyArray<RankedGroup> {
  const recency = new Map(recent.map((id, index) => [id, index]))
  const matches = byScore(items, query)
  const recentMatches = matches
    .filter(({ item }) => recency.has(item.id))
    .toSorted((a, b) => (recency.get(a.item.id) ?? 0) - (recency.get(b.item.id) ?? 0))
  const ranked = [...recentMatches, ...matches.filter(({ item }) => !recency.has(item.id))]

  const groups = new Map<PaletteGroup, Array<Match>>()
  for (const entry of ranked) {
    const group = groups.get(entry.item.group) ?? []
    if (group.length < MAX_ITEMS_PER_GROUP) group.push(entry)
    groups.set(entry.item.group, group)
  }
  return [...groups].map(([group, entries]) => ({ group, items: entries.map(highlight) }))
}
