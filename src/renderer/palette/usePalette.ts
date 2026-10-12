import { create } from "zustand"
import { persist } from "zustand/middleware"

/** Typed first, it limits the palette to commands, as in VS Code. */
export const COMMAND_PREFIX = ">"

const MAX_RECENT = 20

interface PaletteState {
  readonly open: boolean
  readonly query: string
  /** Ids of items run from the palette, most recent first. */
  readonly recent: ReadonlyArray<string>
  readonly show: (query: string) => void
  readonly hide: () => void
  readonly setQuery: (query: string) => void
  readonly remember: (id: string) => void
}

/**
 * Open state and query, so commands can open the palette in a mode. Recent ids persist in
 * localStorage: no settings field fits them, and losing them costs nothing.
 */
export const usePalette = create<PaletteState>()(
  persist(
    (set) => ({
      open: false,
      query: "",
      recent: [],
      show: (query) => set({ open: true, query }),
      hide: () => set({ open: false }),
      setQuery: (query) => set({ query }),
      remember: (id) =>
        set((state) => ({ recent: [id, ...state.recent.filter((other) => other !== id)].slice(0, MAX_RECENT) })),
    }),
    { name: "kkcode.palette", partialize: (state) => ({ recent: state.recent }) },
  ),
)
