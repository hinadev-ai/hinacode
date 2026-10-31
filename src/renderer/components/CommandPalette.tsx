import { Autocomplete } from "@base-ui/react/autocomplete"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { normalizeHotkey, useHotkeys } from "@tanstack/react-hotkeys"
import { useDeferredValue, useEffect, useRef, useState } from "react"
import { useCommandContext, useKeymap } from "../keybindings/useKeybindings.ts"
import { type RankedItem, rankPalette } from "../palette/rank.ts"
import { groupLabels, modeOf } from "../palette/modes.ts"
import type { PaletteContext, PaletteItem, PaletteSource } from "../palette/types.ts"
import { usePalette } from "../palette/usePalette.ts"
import { m } from "../paraglide/messages.js"
import { useClouds } from "../lib/environments.ts"
import { useThreads } from "../stores/threads.ts"
import { ChordKeys } from "./ChordKeys.tsx"
import { CloudMark } from "./CloudMark.tsx"
import { Dialog, DialogOverlay, DialogPortal } from "./ui/dialog.tsx"
import { SearchIcon } from "./icons/SearchIcon.tsx"

type SourceResult = ReturnType<PaletteSource["items"]>

/** Calls every source for the query. Async results join once they settle, so sync groups never wait on files. */
function useSourceItems(sources: ReadonlyArray<PaletteSource>, query: string, ctx: PaletteContext) {
  const results = sources.map((source) => source.items(query, ctx))
  const [settled, setSettled] = useState<ReadonlyMap<SourceResult, ReadonlyArray<PaletteItem>>>(new Map())

  useEffect(() => {
    let current = true
    for (const result of results) {
      if (!(result instanceof Promise)) continue
      void result.then((items) => {
        if (!current) return
        setSettled((previous) =>
          previous.has(result)
            ? previous
            : new Map([...previous].filter(([key]) => results.includes(key))).set(result, items),
        )
      })
    }
    return () => {
      current = false
    }
  }, [results])

  return results.flatMap((result) => (result instanceof Promise ? (settled.get(result) ?? []) : result))
}

const focusOnMount = (input: HTMLInputElement | null) => input?.focus()

/** Bolds the matched characters, so the user sees why a result is there. */
function Highlighted({ text, matches }: { text: string; matches: ReadonlyArray<number> }) {
  if (matches.length === 0) return text
  const matched = new Set(matches)
  const runs: Array<{ text: string; hit: boolean }> = []
  for (let index = 0; index < text.length; index++) {
    const hit = matched.has(index)
    const last = runs.at(-1)
    if (last?.hit === hit) last.text += text[index]
    else runs.push({ text: text[index] ?? "", hit })
  }
  return runs.map((run, index) =>
    run.hit ? (
      <mark key={index} className="bg-transparent font-semibold text-foreground">
        {run.text}
      </mark>
    ) : (
      <span key={index}>{run.text}</span>
    ),
  )
}

function PaletteResult({ entry, onChoose }: { entry: RankedItem; onChoose: (item: PaletteItem) => void }) {
  const { item } = entry
  return (
    <Autocomplete.Item
      value={entry}
      onClick={() => onChoose(item)}
      className="flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none select-none [scroll-margin-block:0.25rem] data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:inset-ring data-highlighted:inset-ring-ring/50"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate">
          <Highlighted text={item.title} matches={entry.titleMatches} />
        </span>
        {item.cloud && (
          <span className="flex shrink-0 items-center gap-1 self-center text-xs text-muted-foreground">
            <CloudMark cloud={item.cloud} className="size-3.5" />
            <span aria-hidden>{item.cloud.name}</span>
          </span>
        )}
        {item.subtitle && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            <Highlighted text={item.subtitle} matches={entry.subtitleMatches} />
          </span>
        )}
      </span>
      {item.chord && <ChordKeys chord={item.chord} />}
    </Autocomplete.Item>
  )
}

function PaletteBody({ onChoose }: { onChoose: (item: PaletteItem, remember: boolean) => void }) {
  const query = usePalette((state) => state.query)
  const recent = usePalette((state) => state.recent)
  const commandContext = useCommandContext()
  const keymap = useKeymap()
  const threads = useThreads((state) => state.byId)
  const clouds = useClouds()
  const ctx = { ...commandContext, keymap, threads, clouds }

  const { mode, query: modeQuery } = modeOf(query)
  const search = useDeferredValue(modeQuery)
  const items = useSourceItems(mode.sources, search, ctx)
  const groups = mode.rank ? mode.rank(items, search) : rankPalette(items, search, recent)
  const choose = (item: PaletteItem) => onChoose(item, mode.rank === undefined)
  // On the document rather than the field, so a chord pressed right after the palette opens, before the field has focus, still counts.
  useHotkeys(
    mode.runsChords
      ? items.flatMap((item) =>
          item.chord ? [{ hotkey: normalizeHotkey(item.chord), callback: () => choose(item) }] : [],
        )
      : [],
  )

  return (
    <Autocomplete.Root
      open
      inline
      items={groups}
      filter={null}
      autoHighlight="always"
      keepHighlight
      value={query}
      onValueChange={(value, details) => {
        // Choosing an item would put its title in the field while the palette closes.
        if (details.reason !== "item-press") usePalette.getState().setQuery(value)
      }}
      itemToStringValue={(entry: RankedItem) => entry.item.title}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-3.5">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {/* Focused on mount rather than by the dialog a frame later, so Enter pressed right after opening chooses. */}
        <Autocomplete.Input
          ref={focusOnMount}
          aria-label={m.palette_search_label()}
          placeholder={mode.placeholder()}
          onKeyDown={(event) => {
            // The always-open list would otherwise take Escape for itself and keep the dialog up.
            if (event.key === "Escape") usePalette.getState().hide()
          }}
          className="h-12 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Autocomplete.Empty className="px-3.5 py-6 text-center text-sm text-muted-foreground empty:hidden">
        {m.palette_empty()}
      </Autocomplete.Empty>
      <Autocomplete.List className="min-h-0 scroll-py-1 overflow-y-auto overscroll-contain p-1.5 data-empty:hidden">
        {(group: (typeof groups)[number]) => (
          <Autocomplete.Group key={group.group} items={group.items} className="not-last:mb-1.5">
            <Autocomplete.GroupLabel className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground select-none">
              {groupLabels[group.group]()}
            </Autocomplete.GroupLabel>
            <Autocomplete.Collection>
              {(entry: RankedItem) => <PaletteResult key={entry.item.id} entry={entry} onChoose={choose} />}
            </Autocomplete.Collection>
          </Autocomplete.Group>
        )}
      </Autocomplete.List>
    </Autocomplete.Root>
  )
}

/** Quick open and command palette in one dialog. Mount once, in the app shell. */
export function CommandPalette() {
  const open = usePalette((state) => state.open)
  const openRequest = usePalette((state) => state.openRequest)
  const chosen = useRef<{ item: PaletteItem; remember: boolean } | null>(null)

  const choose = (item: PaletteItem, remember: boolean) => {
    chosen.current = { item, remember }
    usePalette.getState().hide()
  }

  // Base UI moves focus back to where it was in the frame after the close completes, so the item runs a
  // frame later to keep whatever it focuses, such as the composer or the find bar.
  const runChosen = (isOpen: boolean) => {
    const choice = chosen.current
    chosen.current = null
    if (isOpen || !choice) return
    if (choice.remember) usePalette.getState().remember(choice.item.id)
    requestAnimationFrame(() => choice.item.run())
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : usePalette.getState().hide())}
      onOpenChangeComplete={runChosen}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]">
          {/* No exit transition: the palette gets out of the way at once, so the chosen action runs without a wait. */}
          <DialogPrimitive.Popup
            aria-label={m.palette_label()}
            className="flex max-h-[min(30rem,76dvh)] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition-[opacity,scale] duration-150 ease-(--ease-out) data-starting-style:scale-98 data-starting-style:opacity-0"
          >
            <PaletteBody key={openRequest} onChoose={choose} />
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    </Dialog>
  )
}
