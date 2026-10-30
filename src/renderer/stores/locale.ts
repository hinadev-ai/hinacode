import { create } from "zustand"
import type { Locale } from "../../shared/domain.ts"
import { loadCjkFont } from "../lib/cjkFont.ts"
import { getLocale, setLocale } from "../paraglide/runtime.js"

interface LocaleState {
  readonly locale: Locale
  readonly apply: (locale: Locale) => void
}

export const useLocale = create<LocaleState>()((set) => ({
  locale: getLocale(),
  apply: (locale) => {
    setLocale(locale, { reload: false })
    document.documentElement.lang = locale
    loadCjkFont(locale)
    set({ locale })
  },
}))
