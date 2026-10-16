import { create } from "zustand"
import { persist } from "zustand/middleware"

/** Typed first, it limits the palette to commands, as in VS Code. */
export const COMMAND_PREFIX = ">"

/** Typed first, it searches message text and the open thread's files, as `%` does in VS Code. */
export const SEARCH_PREFIX = "%"

/** Typed first, it picks the project for a new thread. */
export const NEW_THREAD_PREFIX = "+"

const MAX_RECENT = 20

interface PaletteState {
  readonly open: boolean
  readonly query: string
  /** Bumped on each opening so a closing dialog that is still mounted refreshes its sources. */
  readonly openRequest: number
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
      openRequest: 0,
      recent: [],
      show: (query) => set((state) => ({ open: true, query, openRequest: state.openRequest + 1 })),
      hide: () => set({ open: false }),
      setQuery: (query) => set({ query }),
      remember: (id) =>
        set((state) => ({ recent: [id, ...state.recent.filter((other) => other !== id)].slice(0, MAX_RECENT) })),
    }),
    { name: "hinacode.palette", partialize: (state) => ({ recent: state.recent }) },
  ),
)
