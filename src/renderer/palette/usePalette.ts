import { create } from "zustand"
import { persist } from "zustand/middleware"
import { rememberOpener } from "../stores/ui.ts"

export const COMMAND_PREFIX = ">"

export const SEARCH_PREFIX = "%"

export const NEW_THREAD_PREFIX = "+"

export const IMPORT_SESSION_PREFIX = "<"

const MAX_RECENT = 20

interface PaletteState {
  readonly open: boolean
  readonly query: string
  readonly openRequest: number
  readonly recent: ReadonlyArray<string>
  readonly show: (query: string) => void
  readonly hide: () => void
  readonly setQuery: (query: string) => void
  readonly remember: (id: string) => void
}

export const usePalette = create<PaletteState>()(
  persist(
    (set) => ({
      open: false,
      query: "",
      openRequest: 0,
      recent: [],
      show: (query) => {
        rememberOpener()
        set((state) => ({ open: true, query, openRequest: state.openRequest + 1 }))
      },
      hide: () => set({ open: false }),
      setQuery: (query) => set({ query }),
      remember: (id) =>
        set((state) => ({ recent: [id, ...state.recent.filter((other) => other !== id)].slice(0, MAX_RECENT) })),
    }),
    { name: "hinacode.palette", partialize: (state) => ({ recent: state.recent }) },
  ),
)
