import type { Locale } from "../../shared/domain.ts"

const stylesheets: Record<Locale, (() => Promise<unknown>) | null> = {
  en: null,
  ja: () => import("@fontsource-variable/noto-sans-jp/index.css"),
  "zh-TW": () => import("@fontsource-variable/noto-sans-tc/index.css"),
}

export const loadCjkFont = (locale: Locale) => void stylesheets[locale]?.()
