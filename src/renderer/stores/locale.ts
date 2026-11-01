import { create } from "zustand"
import type { Locale } from "../../shared/domain.ts"
import { loadCjkFont } from "../lib/cjkFont.ts"
import { loadLocale } from "../lib/localeCatalogs.ts"
import { getLocale, setLocale } from "../paraglide/runtime.js"

interface LocaleState {
  readonly locale: Locale
  readonly apply: (locale: Locale) => Promise<void>
}

export const useLocale = create<LocaleState>()((set) => ({
  locale: getLocale(),
  apply: async (locale) => {
    await loadLocale(locale)
    setLocale(locale, { reload: false })
    document.documentElement.lang = locale
    loadCjkFont(locale)
    set({ locale })
  },
}))
