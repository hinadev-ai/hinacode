import type { ReactNode } from "react"
import type { Thread } from "../../shared/domain.ts"
import type { CommandContext, Keymap } from "../keybindings/commands.ts"
import type { Cloud } from "../lib/environments.ts"
import type { RankedGroup } from "./rank.ts"

export type PaletteGroup = "commands" | "threads" | "projects" | "files"

export interface PaletteItem {
  readonly id: string
  readonly group: PaletteGroup
  readonly title: string
  readonly subtitle?: string
  readonly keywords?: ReadonlyArray<string>
  readonly chord?: string
  readonly icon?: ReactNode
  readonly cloud?: Cloud
  readonly run: () => void
}

export interface PaletteContext extends CommandContext {
  readonly keymap: Keymap
  readonly threads: Readonly<Record<string, Thread>>
  readonly clouds: ReadonlyArray<Cloud>
}

export interface PaletteSource {
  readonly group: PaletteGroup
  readonly items: (
    query: string,
    ctx: PaletteContext,
  ) => Promise<ReadonlyArray<PaletteItem>> | ReadonlyArray<PaletteItem>
}

export interface PaletteMode {
  readonly id: string
  readonly prefix: string
  readonly placeholder: () => string
  readonly sources: ReadonlyArray<PaletteSource>
  readonly rank?: (items: ReadonlyArray<PaletteItem>, query: string) => ReadonlyArray<RankedGroup>
  readonly runsChords?: boolean
}
