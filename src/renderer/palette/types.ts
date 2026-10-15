import type { ReactNode } from "react"
import type { Thread } from "../../shared/domain.ts"
import type { CommandContext, Keymap } from "../keybindings/commands.ts"
import type { RankedGroup } from "./rank.ts"

export type PaletteGroup = "commands" | "threads" | "projects" | "files"

export interface PaletteItem {
  /** Stable across palette openings, since recently run ids are remembered. */
  readonly id: string
  readonly group: PaletteGroup
  readonly title: string
  readonly subtitle?: string
  /** Matched like the title and subtitle, but not shown. */
  readonly keywords?: ReadonlyArray<string>
  readonly chord?: string
  readonly icon?: ReactNode
  readonly run: () => void
}

/**
 * What a source may read. A command context plus the reactive state the palette re-asks sources on,
 * so a source stays a plain object and never subscribes to anything itself.
 */
export interface PaletteContext extends CommandContext {
  readonly keymap: Keymap
  readonly threads: Readonly<Record<string, Thread>>
}

export interface PaletteSource {
  readonly group: PaletteGroup
  readonly items: (
    query: string,
    ctx: PaletteContext,
  ) => Promise<ReadonlyArray<PaletteItem>> | ReadonlyArray<PaletteItem>
}

/** One way to use the palette, such as commands. A new mode is one more entry in `paletteModes`. */
export interface PaletteMode {
  readonly id: string
  /** Typed first to enter the mode, as in VS Code. Open it from code with `show(prefix + query)`. */
  readonly prefix: string
  readonly placeholder: () => string
  readonly sources: ReadonlyArray<PaletteSource>
  /**
   * Orders and groups the sources' items. The default puts recently run items first, then ranks by
   * fuzzy score, and only items run under the default are remembered as recent.
   */
  readonly rank?: (items: ReadonlyArray<PaletteItem>, query: string) => ReadonlyArray<RankedGroup>
  /** Pressing an item's chord runs it. Off where the chords are global keybindings, which already run. */
  readonly runsChords?: boolean
}
