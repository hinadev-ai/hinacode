import { go } from "fuzzysort"
import type { PaletteGroup, PaletteItem } from "./types.ts"

export interface RankedItem {
  readonly item: PaletteItem
  /** Indexes of the title characters the query matched. */
  readonly titleMatches: ReadonlyArray<number>
  readonly subtitleMatches: ReadonlyArray<number>
}

export interface RankedGroup {
  readonly group: PaletteGroup
  readonly items: ReadonlyArray<RankedItem>
}

/** Rendering more than this per group buys nothing, and keeps a 50k-file repo cheap without virtualizing. */
export const MAX_ITEMS_PER_GROUP = 50

const byScore = (items: ReadonlyArray<PaletteItem>, query: string): ReadonlyArray<RankedItem> => {
  if (query.trim() === "") return items.map((item) => ({ item, titleMatches: [], subtitleMatches: [] }))
  return go(query, items, {
    keys: [(item) => item.title, (item) => item.subtitle, (item) => item.keywords?.join(" ")],
    threshold: 0,
    limit: 0,
  }).map((result) => ({
    item: result.obj,
    titleMatches: result[0]?.indexes ?? [],
    subtitleMatches: result[1]?.indexes ?? [],
  }))
}

/**
 * Filters `items` by `query` and groups them. Recently run items come first, most recent first, then
 * the rest by fuzzy score. An empty query keeps the given order after the recent items. Groups are
 * ordered by their best item.
 *
 * @param recent item ids, most recent first
 */
export function rankPalette(
  items: ReadonlyArray<PaletteItem>,
  query: string,
  recent: ReadonlyArray<string>,
): ReadonlyArray<RankedGroup> {
  const recency = new Map(recent.map((id, index) => [id, index]))
  const order = ({ item }: RankedItem) => recency.get(item.id) ?? recent.length
  const ranked = byScore(items, query).toSorted((a, b) => order(a) - order(b))

  const groups = new Map<PaletteGroup, Array<RankedItem>>()
  for (const entry of ranked) {
    const group = groups.get(entry.item.group) ?? []
    if (group.length < MAX_ITEMS_PER_GROUP) group.push(entry)
    groups.set(entry.item.group, group)
  }
  return [...groups].map(([group, entries]) => ({ group, items: entries }))
}
