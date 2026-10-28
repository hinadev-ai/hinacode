import type { Locale } from "../../shared/domain.ts"

// Han and kana glyphs differ between regions, so index.css picks the font by UI language. Each font's stylesheet
// declares over a hundred unicode-range slices, so only the active language's loads, and only once it is picked.
const stylesheets: Record<Locale, (() => Promise<unknown>) | null> = {
  en: null,
  ja: () => import("@fontsource-variable/noto-sans-jp/index.css"),
  "zh-TW": () => import("@fontsource-variable/noto-sans-tc/index.css"),
}

export const loadCjkFont = (locale: Locale) => void stylesheets[locale]?.()
