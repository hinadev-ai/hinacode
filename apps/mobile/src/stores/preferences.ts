import { create } from "zustand"
import { defaultPreferences, type Preferences } from "@/lib/preferences"
import { loadPreferences, savePreferences } from "@/lib/storage"

interface PreferencesState extends Preferences {
  /** Reads the stored choices once at launch. Until then the defaults apply. */
  readonly restore: () => Promise<void>
  readonly set: (patch: Partial<Preferences>) => void
}

const snapshot = ({ appearance, notifications, homeTab }: Preferences): Preferences => ({
  appearance,
  notifications,
  homeTab,
})

export const usePreferences = create<PreferencesState>()((set, get) => ({
  ...defaultPreferences,
  restore: async () => set(await loadPreferences()),
  set: (patch) => {
    set(patch)
    void savePreferences(snapshot(get()))
  },
}))
